const axios = require('axios');
const _ = require('lodash');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const fs = require('fs')
const tokenCachePath = './.td_token_cache.json';
const TOKEN_TTL_DAYS = 180;
require('dotenv').config();

dayjs.extend(utc);
dayjs.extend(timezone);

const getAuthToken = async () => {
  const { TD_USER_EMAIL, TD_USER_PASSWORD } = process.env;

  const res = await axios.post('https://api2.timedoctor.com/api/1.0/login', {
    email: TD_USER_EMAIL,
    password: TD_USER_PASSWORD,
    permissions: "read"
  });

  return res.data.data.token;
};

const getCachedToken = async () => {
  if (fs.existsSync(tokenCachePath)) {
    const { token, expiresAt } = JSON.parse(fs.readFileSync(tokenCachePath, 'utf8'));
    if (dayjs().isBefore(expiresAt)) return token;
  }

  const token = await getAuthToken();
  console.log("TOKEN: ", token)
  const expiresAt = dayjs().add(TOKEN_TTL_DAYS, 'days').toISOString();
  fs.writeFileSync(tokenCachePath, JSON.stringify({ token, expiresAt }, null, 2));

  return token;
};


const CHICAGO_TZ = 'America/Chicago';
const BREAK_THRESHOLD_MINUTES = 180;
const TD_COMPANY_ID = process.env.TD_COMPANY_ID;
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
console.log("Starting Time Doctor -> Monday.com Time Logs Migration")

const USER_GROUP_MAP = JSON.parse(process.env.USER_GROUP_MAP || '{}');

const COLUMN_TITLES = {
  clockIn: 'Clock In',
  clockOut: 'Clock Out',
  date: 'Date',
  totalWorkedHours: 'Total Worked Hours'
};

const getBiweeklyBoardTitle = () => {
  const now = dayjs().tz(CHICAGO_TZ);
  const day = now.date();
  const month = now.format('MMMM');
  if (day <= 15) {
    return `${month} 1 - ${month} 15`;
  } else {
    const endOfMonth = now.endOf('month').date();
    return `${month} 16 - ${month} ${endOfMonth}`;
  }
};

const parseWorklogTimes = (logs) => {
  if (!logs || logs.length === 0) return { clockInTime: null, clockOutTime: null, totalSeconds: 0 };

  const sorted = logs.slice().sort((a, b) => new Date(a.start) - new Date(b.start));
  const earliestLog = sorted[0];
  const latestLog = sorted[sorted.length - 1];

  const clockInTime = dayjs(earliestLog.start).tz(CHICAGO_TZ).format();
  const clockOutTime = dayjs(latestLog.start).add(latestLog.time, 'seconds').tz(CHICAGO_TZ).format();
  const totalSeconds = _.sumBy(sorted, log => log.time);

  return { clockInTime, clockOutTime, totalSeconds };
};

const months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const getAllBoards = async () => {
  const query = `
    query {
      boards(limit: 100) {
        id
        name
      }
    }
  `;

  const res = await axios.post('https://api.monday.com/v2', { query }, {
    headers: {
      Authorization: MONDAY_API_KEY,
      'Content-Type': 'application/json'
    }
  });

  return res.data.data.boards || [];
};


const getOrCreateBoardByTitle = async (targetTitle) => {
  const existingId = await getBoardIdByTitle(targetTitle);
  if (existingId) return existingId;

  console.log(`🧱 Board "${targetTitle}" not found. Looking for previous template...`);

  const boards = await getAllBoards();

  const match = /^([A-Za-z]+) (1 - \1 15|16 - \1 \d{1,2})$/.exec(targetTitle);
  if (!match) throw new Error(`❌ Title "${targetTitle}" does not match expected format.`);

  const currentMonth = match[1];
  const range = match[2];

  const monthIndex = months.findIndex(m => m.toLowerCase() === currentMonth.toLowerCase());
  if (monthIndex <= 0) throw new Error(`❌ Invalid or earliest month: ${currentMonth}`);

  const previousMonth = months[monthIndex - 1];
  const templateTitle = `${previousMonth} ${range.replaceAll(currentMonth, previousMonth)}`;

  const template = boards.find(b => b.name === templateTitle);
  if (!template) throw new Error(`❌ No template board found: "${templateTitle}"`);

  console.log(`📋 Duplicating "${templateTitle}" as "${targetTitle}"...`);
  const newBoard = await duplicateBoard(template.id, targetTitle);

  return newBoard?.id;
};

const duplicateBoard = async (sourceBoardId, newBoardName) => {
  const query = `
    mutation {
      duplicate_board(
        board_id: ${sourceBoardId},
        duplicate_type: duplicate_board_with_structure,
        board_name: "${newBoardName}"
      ) {
        board {
          id
          name
        }
      }
    }
  `;

  const res = await axios.post('https://api.monday.com/v2', { query }, {
    headers: {
      Authorization: MONDAY_API_KEY,
      'Content-Type': 'application/json'
    }
  });

  return res.data.data.duplicate_board.board;
};


const getBoardIdByTitle = async (title) => {
  const query = `
    query {
      boards(limit: 100) {
        id
        name
      }
    }
  `;
  const res = await axios.post('https://api.monday.com/v2', { query }, {
    headers: {
      Authorization: MONDAY_API_KEY,
      'Content-Type': 'application/json'
    }
  });

  const board = res.data.data.boards.find(b => b.name === title);
  return board?.id;
};

const getBoardColumnIdsByTitle = async (boardId) => {
  const query = `
    query {
      boards(ids: [${boardId}]) {
        columns {
          id
          title
        }
      }
    }
  `;
  const res = await axios.post('https://api.monday.com/v2', { query }, {
    headers: {
      Authorization: MONDAY_API_KEY,
      'Content-Type': 'application/json'
    }
  });

  const columns = res.data.data.boards[0].columns;
  const result = {};

  for (const [key, title] of Object.entries(COLUMN_TITLES)) {
    const match = columns.find(col => col.title.trim().toLowerCase() === title.toLowerCase());
    if (!match) throw new Error(`Column titled "${title}" not found.`);
    result[key] = match.id;
  }

  return result;
};

const findItemInGroup = async (boardId, groupId, itemName) => {
  const query = `
    query {
      boards(ids: [${boardId}]) {
        items_page(limit: 500) {
          items {
            id
            name
            group {
              id
            }
          }
        }
      }
    }
  `;

  const res = await axios.post('https://api.monday.com/v2', { query }, {
    headers: {
      Authorization: MONDAY_API_KEY,
      'Content-Type': 'application/json'
    }
  });

  const items = res.data.data.boards?.[0]?.items_page?.items || [];
  const match = items.find(
    item => item.group.id === groupId && item.name.trim().toLowerCase() === itemName.trim().toLowerCase()
  );

  return match?.id;
};

const createItemInGroup = async (boardId, groupId, itemName) => {
  const mutation = `
    mutation {
      create_item(board_id: ${boardId}, group_id: "${groupId}", item_name: "${itemName}") {
        id
      }
    }
  `;
  const res = await axios.post('https://api.monday.com/v2', { query: mutation }, {
    headers: {
      Authorization: MONDAY_API_KEY,
      'Content-Type': 'application/json'
    }
  });

  return res.data.data.create_item.id;
};

const getItemColumnValues = async (itemId, columnIds) => {
  const query = `
    query {
      items(ids: [${itemId}]) {
        column_values(ids: ["${columnIds.clockIn}", "${columnIds.clockOut}", "${columnIds.date}", "${columnIds.totalWorkedHours}"]) {
          id
          text
        }
      }
    }
  `;
  const res = await axios.post('https://api.monday.com/v2', { query }, {
    headers: {
      Authorization: MONDAY_API_KEY,
      'Content-Type': 'application/json'
    }
  });

  const values = res.data.data.items[0].column_values;
  return {
    clockIn: values.find(c => c.id === columnIds.clockIn)?.text,
    clockOut: values.find(c => c.id === columnIds.clockOut)?.text,
    date: values.find(c => c.id === columnIds.date)?.text,
    totalWorkedHours: values.find(c => c.id === columnIds.totalWorkedHours)?.text
  };
};

const createGroup = async (boardId, groupTitle) => {
  const mutation = `
    mutation {
      create_group (board_id: ${boardId}, group_name: "${groupTitle}") {
        id
      }
    }
  `;

  const res = await axios.post('https://api.monday.com/v2', { query: mutation }, {
    headers: {
      Authorization: MONDAY_API_KEY,
      'Content-Type': 'application/json'
    }
  });

  const groupId = res.data.data.create_group.id;
  console.log(`➕ Created group "${groupTitle}" → ID: ${groupId}`);
  return groupId;
};


const getGroupIdByTitle = async (boardId, groupTitle) => {
  const query = `
    query {
      boards(ids: [${boardId}]) {
        groups {
          id
          title
        }
      }
    }
  `;

  const res = await axios.post('https://api.monday.com/v2', { query }, {
    headers: { Authorization: MONDAY_API_KEY }
  });

  const groups = res.data.data.boards[0].groups;
  const match = groups.find(g => g.title.trim().toLowerCase() === groupTitle.trim().toLowerCase());

  if (match) return match.id;

  // ❌ Group not found → Create it
  return await createGroup(boardId, groupTitle);
};

  const updateMondayItem = async (boardId, itemId, updates) => {
    const mutation = `
      mutation ($itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(item_id: $itemId, board_id: ${boardId}, column_values: $columnValues) {
          id
        }
      }
    `;
    const variables = {
      itemId: String(itemId),  // ensure it's a string
      columnValues: JSON.stringify(updates)
    };
  
    await axios.post('https://api.monday.com/v2', { query: mutation, variables }, {
      headers: {
        Authorization: MONDAY_API_KEY,
        'Content-Type': 'application/json'
      }
    });
  };

const startTimeTracking = async (itemId, columnId) => {
  const mutation = `
    mutation {
      start_time_tracking(item_id: ${itemId}, column_id: "${columnId}") {
        id
      }
    }
  `;
  await axios.post('https://api.monday.com/v2', { query: mutation }, {
    headers: {
      Authorization: MONDAY_API_KEY,
      'Content-Type': 'application/json'
    }
  });
};

const stopTimeTracking = async (itemId, columnId) => {
  const mutation = `
    mutation {
      stop_time_tracking(item_id: ${itemId}, column_id: "${columnId}") {
        id
      }
    }
  `;
  await axios.post('https://api.monday.com/v2', { query: mutation }, {
    headers: {
      Authorization: MONDAY_API_KEY,
      'Content-Type': 'application/json'
    }
  });
};

// === MAIN ===
(async () => {
  try {
    const now = dayjs().tz(CHICAGO_TZ);
    const itemName = now.format('MMM D');
    const todayDate = now.toISOString();
    const boardTitle = getBiweeklyBoardTitle();

    const boardId = await getOrCreateBoardByTitle(boardTitle);
    if (!boardId) throw new Error(`❌ Board not found: "${boardTitle}"`);

    const columnIds = await getBoardColumnIdsByTitle(boardId);

    const TD_API_KEY = await getCachedToken();

    const usersResponse = await axios.get("https://api2.timedoctor.com/api/1.0/users", {
      headers: { Authorization: `JWT ${TD_API_KEY}` },
      params: { company: TD_COMPANY_ID }
    });

    const users = usersResponse.data?.data ?? [];
    const userIds = users.map(user => user.id);
    let userInfos = users;
    console.log("👥 Users loaded:", userInfos.length);

    const worklogsResponse = await axios.get("https://api2.timedoctor.com/api/1.0/activity/worklog", {
      headers: { Authorization: `JWT ${TD_API_KEY}` },
      params: {
        company: TD_COMPANY_ID,
        user: userIds.join(','),
        from: now.startOf('day').toISOString()
      }
    });

    const allWorklogs = worklogsResponse.data?.data ?? [];

    // Attach logs to users
    userInfos = userInfos.map((user, index) => ({
      ...user,
      worklogs: allWorklogs[index] || []
    }));

    console.log("📦 Grouped User Info:", userInfos.length);
    const grouped = _.groupBy(userInfos, 'email');

    for (const email in grouped) {
      const userInfo = grouped[email][0];
      const logs = userInfo.worklogs;
    
      console.log(`\n👤 Processing: ${email} (User ID: ${userInfo.id})`);
      console.log(`📁 Worklogs found: ${logs?.length || 0}`);
    
      if (!logs || logs.length === 0) {
        console.warn(`⚠️ No worklogs for ${email}, skipping.`);
        continue;
      }
    
      const groupTitle = USER_GROUP_MAP[email];
      if (!groupTitle) {
        console.warn(`⚠️ No group title mapped for ${email}`);
        continue;
      }
    
      let groupId;
      try {
        groupId = await getGroupIdByTitle(boardId, groupTitle);
      } catch (err) {
        console.warn(err.message);
        continue;
      }
    
      const { clockInTime, totalSeconds } = parseWorklogTimes(logs);
      const hoursWorked = totalSeconds / 3600;
      
    
      let clockOutTime = null;

      const lastTracked = userInfo.lastTrackGlobal?.activeAt;
      const lastTrackedMoment = lastTracked ? dayjs(lastTracked).tz(CHICAGO_TZ) : null;
      
      
      const idleTooLong = lastTrackedMoment
        ? now.diff(lastTrackedMoment, 'minute') > BREAK_THRESHOLD_MINUTES
        : true; // treat as idle if no tracking
      
      if (lastTrackedMoment && lastTrackedMoment.isSame(now, 'day') && !idleTooLong) {
        console.log(`🟢 ${email} is still working. Skipping Clock Out.`);
        clockOutTime = null; // skip setting clock out
      } else if (idleTooLong && logs.length > 0) {
        const lastLog = _.maxBy(logs, log =>
          new Date(dayjs(log.start).add(log.time, 'seconds').toISOString())
        );
        clockOutTime = dayjs(lastLog.start).add(lastLog.time, 'seconds').tz(CHICAGO_TZ).format();
        console.log(`📦 ${email} likely stopped. Clock Out = ${clockOutTime}`);
      } else {
        console.warn(`⚠️ No clock-out info for ${email}`);
      }
    
      console.log(`🕒 Clock In: ${clockInTime || 'N/A'}, Clock Out: ${clockOutTime || 'N/A'}, Hours Worked: ${hoursWorked.toFixed(2)}`);
    
      let itemId = await findItemInGroup(boardId, groupId, itemName);
      if (!itemId && now.isSame(dayjs(), 'day')) {
        console.log(`➕ Creating item "${itemName}" in group "${groupId}"`);
        itemId = await createItemInGroup(boardId, groupId, itemName);
      }
    
      if (!itemId) {
        console.warn(`❌ No item found for "${itemName}" and not creating`);
        continue;
      }
    
      const existing = await getItemColumnValues(itemId, columnIds);
      const updates = {};
    
      if (!existing.clockIn && clockInTime) {
        const dt = dayjs(clockInTime).tz(CHICAGO_TZ);
        updates[columnIds.clockIn] = {
          hour: dt.hour(),
          minute: dt.minute()
        };
      }
      
      if (!existing.clockOut && clockOutTime) {
        const dt = dayjs(clockOutTime).tz(CHICAGO_TZ);
        updates[columnIds.clockOut] = {
          hour: dt.hour(),
          minute: dt.minute()
        };
      }
      
      if (!existing.date) {
        const dt = dayjs(todayDate).tz(CHICAGO_TZ);
        updates[columnIds.date] = {
          date: dt.format('YYYY-MM-DD'),
          time: dt.format('HH:mm:ss')
        };
      }

      if (hoursWorked > 0) {
        updates[columnIds.totalWorkedHours] = hoursWorked;
      }
    
      if (_.isEmpty(updates)) {
        console.log(`⏩ No updates needed — already set or missing data`);
        continue;
      }
    
      await updateMondayItem(boardId, itemId, updates);
      console.log(`✅ Monday.com updated for ${email}`);
    }

    // Summary of skipped users with no logs
    const skipped = userInfos.filter(u => !u.worklogs || u.worklogs.length === 0);
    console.log(`\n⛔ Skipped ${skipped.length} user(s) with no worklogs today:`);
    skipped.forEach(u => console.log(`- ${u.email}`));

  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message || err);
  }
})();
