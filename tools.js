// tools.js
const DB = require('./database');

// 1. Tool Definitions
const toolsDefinition = [
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
      description: "Update affinity level based on the interaction.",
      parameters: {
        type: "object",
        properties: {
          change: { type: "integer", enum: [1, -1, 0] },
        },
        required: ["change"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_busy_status",
      description: "Mark the user as busy for a specific activity (gaming, working, etc).",
      parameters: {
        type: "object",
        properties: {
          activity: { type: "string" }
        },
        required: ["activity"],
      },
    },
  },
  // --- NEW TOOL: GOOGLE SEARCH ---
  {
    type: "function",
    function: {
      name: "google_search",
      description: "Search the internet for real-time information, news, or facts you don't know.",
      parameters: {
        type: "object",
        properties: {
          query: { 
            type: "string", 
            description: "The search terms to send to Google." 
          }
        },
        required: ["query"],
      },
    },
  }
];

// 2. Tool Logic
const availableTools = {
  recall_past_interactions: async ({ keywords }) => {
    const results = await DB.searchMemory(keywords);
    if (results.length === 0) return "No records found matching those keywords.";
    return JSON.stringify(results);
  },

  update_emotional_state: async ({ change }) => {
    return await DB.updateAffinity(change);
  },
  
  set_busy_status: async ({ activity }) => {
    const futureDate = new Date();
    futureDate.setHours(futureDate.getHours() + 2);
    await DB.setBusyUntil(futureDate.toISOString());
    return `System: User marked as busy with '${activity}' for 2 hours.`;
  },

  // --- NEW TOOL LOGIC ---
  google_search: async ({ query }) => {
    const apiKey = process.env.PSE_API_KEY;
    const cx = process.env.PSE_ID;
    
    if (!apiKey || !cx) return "Error: Search credentials not configured in .env";

    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Google API Status: ${response.status}`);
      }

      const data = await response.json();

      if (!data.items || data.items.length === 0) {
        return "Google Search returned no results.";
      }

      // Format results to save context window space (Top 5 results)
      const formattedResults = data.items.slice(0, 5).map(item => {
        return `[Title]: ${item.title}\n[Snippet]: ${item.snippet}\n[Link]: ${item.link}`;
      }).join('\n---\n');

      return formattedResults;

    } catch (error) {
      console.error("Search Error:", error);
      return `Failed to perform search: ${error.message}`;
    }
  }
};

module.exports = { toolsDefinition, availableTools };