// tools.js
const DB = require('./database');

// 1. Tool Definitions (Schema for Groq)
const toolsDefinition = [
  {
    type: "function",
    function: {
      name: "recall_past_interactions",
      description: "Search long-term memory database for previous conversations based on keywords.",
      parameters: {
        type: "object",
        properties: {
          keywords: {
            type: "string",
            description: "The specific keyword or phrase to search for (e.g., 'favorite color', 'project alpha').",
          },
        },
        required: ["keywords"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_emotional_state",
      description: "Update your affinity level towards the user based on the current interaction.",
      parameters: {
        type: "object",
        properties: {
          change: {
            type: "integer",
            description: "1 for positive/happy interaction, -1 for negative/rude interaction, 0 for neutral.",
            enum: [1, -1, 0]
          },
        },
        required: ["change"],
      },
    },
  }
];

// 2. Tool Execution Logic
const availableTools = {
  recall_past_interactions: async ({ keywords }) => {
    const results = await DB.searchMemory(keywords);
    if (results.length === 0) return "No records found matching those keywords.";
    return JSON.stringify(results);
  },
  
  update_emotional_state: async ({ change }) => {
    const result = await DB.updateAffinity(change);
    return result;
  }
};

module.exports = { toolsDefinition, availableTools };