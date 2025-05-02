const axios = require('axios');
const _ = require('lodash');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
require('dotenv').config();

dayjs.extend(utc);
dayjs.extend(timezone);

const CHICAGO_TZ = 'America/Chicago';

const TD_API_KEY = process.env.TD_API_KEY;
const TD_COMPANY_ID = process.env.TD_COMPANY_ID;
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;

const USER_GROUP_MAP = JSON.parse(process.env.USER_GROUP_MAP || '{}');

const COLUMN_TITLES = {
  clockIn: 'Clock In',
  clockOut: 'Clock Out',
  date: 'Date',
  timeTracking: 'Total Worked Hours'
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
        groups(ids: ["${groupId}"]) {
          items {
            id
            name
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

  const items = res.data.data.boards[0].groups[0].items;
  const item = items.find(i => i.name.trim() === itemName);
  return item?.id;
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
        column_values(ids: ["${columnIds.clockIn}", "${columnIds.clockOut}", "${columnIds.date}"]) {
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
    date: values.find(c => c.id === columnIds.date)?.text
  };
};

const updateMondayItem = async (boardId, itemId, updates) => {
  const mutation = `
    mutation ($itemId: Int!, $columnValues: JSON!) {
      change_multiple_column_values(item_id: $itemId, board_id: ${boardId}, column_values: $columnValues) {
        id
      }
    }
  `;
  const variables = {
    itemId,
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
    const todayDate = now.format('YYYY-MM-DD');
    const boardTitle = getBiweeklyBoardTitle();

    const boardId = await getBoardIdByTitle(boardTitle);
    if (!boardId) throw new Error(`❌ Board not found: "${boardTitle}"`);

    const columnIds = await getBoardColumnIdsByTitle(boardId);

    const worklogs = await axios.get(`https://api2.timedoctor.com/api/1.0/companies/${TD_COMPANY_ID}/worklogs`, {
      headers: { Authorization: `Bearer ${TD_API_KEY}` },
      params: {
        start_date: todayDate,
        end_date: todayDate
      }
    });

    const grouped = _.groupBy(worklogs.data.data.worklogs, 'user_email');

    for (const email in grouped) {
      const logs = grouped[email];
      const groupId = USER_GROUP_MAP[email];
      if (!groupId) {
        console.warn(`⚠️ No group mapped for ${email}`);
        continue;
      }

      const earliest = _.minBy(logs, log => new Date(log.start_time));
      const latest = _.maxBy(logs, log => new Date(log.end_time));
      const totalSeconds = _.sumBy(logs, 'duration');
      const hoursWorked = totalSeconds / 3600;

      const clockInTime = earliest ? dayjs(earliest.start_time).tz(CHICAGO_TZ).format() : null;
      const clockOutTime = latest && hoursWorked >= 8 ? dayjs(latest.end_time).tz(CHICAGO_TZ).format() : null;

      let itemId = await findItemInGroup(boardId, groupId, itemName);
      if (!itemId && now.isSame(dayjs(), 'day')) {
        console.log(`➕ Creating item "${itemName}" in "${groupId}"`);
        itemId = await createItemInGroup(boardId, groupId, itemName);
      }

      if (!itemId) {
        console.warn(`❌ No item found for "${itemName}" and not creating`);
        continue;
      }

      const existing = await getItemColumnValues(itemId, columnIds);
      const updates = {};

      if (!existing.clockIn && clockInTime) {
        updates[columnIds.clockIn] = clockInTime;
        await startTimeTracking(itemId, columnIds.timeTracking);
        console.log(`⏱️ Started time tracking for ${email}`);
      }

      if (!existing.clockOut && clockOutTime) {
        updates[columnIds.clockOut] = clockOutTime;
        await stopTimeTracking(itemId, columnIds.timeTracking);
        console.log(`🛑 Stopped time tracking for ${email}`);
      }

      if (!existing.date) {
        updates[columnIds.date] = { date: todayDate };
      }

      if (_.isEmpty(updates)) {
        console.log(`⏩ No updates needed for ${email}`);
        continue;
      }

      await updateMondayItem(boardId, itemId, updates);
      console.log(`✅ Updated ${email}:`, updates);
    }

  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message);
  }
})();
