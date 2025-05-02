const axios = require('axios');
require('dotenv').config()


// === CONFIG ===
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;

console.log("MONDAY API KEY: ", MONDAY_API_KEY)

// === Axios setup ===
const monday = axios.create({
  baseURL: 'https://api.monday.com/v2',
  headers: {
    Authorization: MONDAY_API_KEY,
    'Content-Type': 'application/json'
  }
});

// === 1. Get all boards ===
const getBoards = async () => {
  const query = `
    query {
      boards(limit: 50) {
        id
        name
      }
    }
  `;

  const res = await monday.post('', { query });
  console.log('📋 Boards:');
  res.data.data.boards.forEach(board => {
    console.log(`- ${board.name} (ID: ${board.id})`);
  });
};

// === 2. Get all groups in a board ===
const getGroups = async (boardId) => {
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

  const res = await monday.post('', { query });
  console.log(`📂 Groups in Board ${boardId}:`);
  res.data.data.boards[0].groups.forEach(group => {
    console.log(`- ${group.title} (ID: ${group.id})`);
  });
};

// === 3. Get all items in a group ===
const getItemsInGroup = async (boardId, groupId) => {
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

  const res = await monday.post('', { query }).catch(() => null);
  const items = res.data.data.boards[0].groups[0].items;

  console.log(`📝 Items in Group "${groupId}":`);
  items.forEach(item => {
    console.log(`- ${item.name} (ID: ${item.id})`);
  });
};

const getGroupColumnDefinitions = async (boardId) => {
    const query = `
      query {
        boards(ids: [${boardId}]) {
          columns {
            id
            title
            type
          }
        }
      }
    `;
  
    const res = await monday.post('', { query });
    const columns = res.data.data.boards[0].columns;
  
    console.log(`🧱 Columns for Board ${boardId}:`);
    columns.forEach(col => {
      console.log(`- ${col.title} (id: ${col.id}, type: ${col.type})`);
    });
  };


// === RUN TESTS ===
(async () => {
  await getBoards();

  const boardId = 0; 
  await getGroups(boardId);
  await getGroupColumnDefinitions(boardId);
})();
