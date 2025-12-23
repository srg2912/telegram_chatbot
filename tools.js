// tools.js
const DB = require('./database');

const toolsDefinition = [
  // ... Previous tools (recall_past_interactions, update_emotional_state) ...
  {
    type: "function",
    function: {
      name: "recall_past_interactions",
      description: "Search long-term memory database for previous conversations based on keywords.",
      parameters: {
        type: "object",
        properties: {
          keywords: { type: "string" },
        },
        required: ["keywords"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_emotional_state",
      description: "Update affinity level.",
      parameters: {
        type: "object",
        properties: {
          change: { type: "integer", enum: [1, -1, 0] },
        },
        required: ["change"],
      },
    },
  },
  // --- NEW TOOL ---
  {
    type: "function",
    function: {
      name: "set_busy_status",
      description: "Use this when the user mentions they are going to do a specific activity (gaming, studying, working) and will be away.",
      parameters: {
        type: "object",
        properties: {
          activity: {
            type: "string",
            description: "The activity the user is going to do.",
          }
        },
        required: ["activity"],
      },
    },
  }
];

const availableTools = {
  recall_past_interactions: async ({ keywords }) => {
    const results = await DB.searchMemory(keywords);
    if (results.length === 0) return "No records found matching those keywords.";
    return JSON.stringify(results);
  },
  update_emotional_state: async ({ change }) => {
    const result = await DB.updateAffinity(change);
    return result;
  },
  
  // --- NEW TOOL LOGIC ---
  set_busy_status: async ({ activity }) => {
    // Current time + 2 hours
    const futureDate = new Date();
    futureDate.setHours(futureDate.getHours() + 2);
    
    await DB.setBusyUntil(futureDate.toISOString());
    return `System updated: You will not autonomously disturb the user for 2 hours while they are ${activity}.`;
  }
};

module.exports = { toolsDefinition, availableTools };