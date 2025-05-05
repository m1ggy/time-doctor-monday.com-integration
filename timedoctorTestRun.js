const axios = require('axios');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
require('dotenv').config();

dayjs.extend(utc);
dayjs.extend(timezone);

const CHICAGO_TZ = 'America/Chicago';

const TD_API_KEY = process.env.TD_API_KEY;

console.log('⛓️ Time Doctor API Key:', TD_API_KEY);

const td = axios.create({
  baseURL: 'https://api2.timedoctor.com/api/1.0',
  headers: {
    Authorization: `Bearer ${TD_API_KEY}`
  }
});

// === 1. Get company info ===
const getCompanyInfo = async () => {
  const res = await td.get('/companies');
  const company = res.data.data.companies[0];
  console.log(`🏢 Company: ${company.name} (ID: ${company.id})`);
  return company.id;
};

// === 2. Get company users ===
const getUsers = async (companyId) => {
  const res = await td.get(`/companies/${companyId}/users`);
  const users = res.data.data.users;
  console.log(`👥 Users:`);
  users.forEach(user => {
    console.log(`- ${user.full_name} (${user.email}) [ID: ${user.id}]`);
  });
  return users;
};

// === 3. Get today's worklogs for all users ===
const getTodayWorklogs = async (companyId) => {
  const today = dayjs().tz(CHICAGO_TZ).format('YYYY-MM-DD');
  const res = await td.get(`/companies/${companyId}/worklogs`, {
    params: {
      start_date: today,
      end_date: today
    }
  });

  const logs = res.data.data.worklogs;
  console.log(`🕒 Worklogs for ${today}:`);
  logs.forEach(log => {
    console.log(`- ${log.user_email}: ${log.start_time} → ${log.end_time} (${log.duration} sec)`);
  });
};

// === RUN TESTS ===
(async () => {
  try {
    const companyId = await getCompanyInfo();
    await getUsers(companyId);
    await getTodayWorklogs(companyId);
  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message);
  }
})();
