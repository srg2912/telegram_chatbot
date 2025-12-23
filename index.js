require('dotenv').config();
const fs = require('fs');
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const DB = require('./database');
const { toolsDefinition, availableTools } = require('./tools');

// Initialize API Clients
const bot = new Telegraf(process.env.BOT_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Load Personality File synchronously at startup
let personalityText = "";
try {
  personalityText = fs.readFileSync('./personality.txt', 'utf8');
} catch (err) {
  console.error("Warning: personality.txt not found. Using default.");
  personalityText = "You are a helpful assistant named Nano.";
}

/**
 * Generates the System Prompt based on current state
 */
const getSystemPrompt = (affinity, extraContext = "") => {
  let tone = "neutral";
  if (affinity > 50) tone = "loving, enthusiastic, and affectionate";
  else if (affinity > 20) tone = "warm and friendly";
  else if (affinity < -50) tone = "hostile, short, and annoyed";
  else if (affinity < -10) tone = "cold and distant";

  return `
  ${personalityText}

  CURRENT STATUS:
  - Affinity Level: ${affinity} (Range: -100 to 100).
  - Current Tone: ${tone}.
  
  CONTEXT NOTES:
  ${extraContext}
  
  INSTRUCTIONS:
  1. **Internet Search:** If the user asks for current events, news, or specific facts you don't know, USE 'google_search'.
  2. **Busy Status:** If the user mentions doing a specific activity (gaming, working, studying), USE 'set_busy_status'.
  3. **Memory:** If the user asks about previous conversations, USE 'recall_past_interactions'.
  4. **Affinity:** If the user compliments or insults you, USE 'update_emotional_state'.
  5. **General:** Keep responses concise and conversational.
  `;
};

/**
 * Helper: Orchestrates Groq calls, Tool execution, and Telegram sending
 */
async function generateResponse(messages, chatId) {
  try {
    // 1. First Call to Groq
    const completion = await groq.chat.completions.create({
      messages: messages,
      model: "llama3-70b-8192",
      tools: toolsDefinition,
      tool_choice: "auto",
    });

    const responseMessage = completion.choices[0].message;
    let finalContent = responseMessage.content;

    // 2. Handle Tool Calls if any
    if (responseMessage.tool_calls) {
      messages.push(responseMessage); // Add the intent to history

      for (const toolCall of responseMessage.tool_calls) {
        const fnName = toolCall.function.name;
        const fnArgs = JSON.parse(toolCall.function.arguments);
        
        console.log(`[Tool Executed] ${fnName} with args:`, fnArgs);
        
        // Execute the local function
        const toolOutput = await availableTools[fnName](fnArgs);

        // Append result to history
        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: fnName,
          content: toolOutput,
        });
      }

      // 3. Second Call to Groq (to generate text based on tool output)
      const secondResponse = await groq.chat.completions.create({
        messages: messages,
        model: "llama3-70b-8192",
      });
      
      finalContent = secondResponse.choices[0].message.content;
    }

    // 4. Send to Telegram and Save to DB
    if (finalContent) {
      await bot.telegram.sendMessage(chatId, finalContent);
      await DB.addMessage('assistant', finalContent);
    }

  } catch (error) {
    console.error("Generation Error:", error);
    // Optional: send an error message to user, or just stay silent
  }
}

/**
 * EVENT: User sends a message
 */
bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  const chatId = ctx.chat.id;

  // 1. Update User State
  DB.setChatId(chatId);
  DB.updateStreak(0); // Reset autonomous streak (user is back)
  await DB.setBusyUntil(null); // Clear busy status (user is back)

  // 2. Sleep Detection Logic
  const lastMsg = await DB.getLastMessage();
  let sleepContext = "";
  
  if (lastMsg) {
    const lastDate = new Date(lastMsg.timestamp + "Z"); // Treat as UTC
    const now = new Date();
    const hoursDiff = (now - lastDate) / (1000 * 60 * 60);
    
    // If > 6 hours silence and it is now Daytime (10am+), assume they slept
    if (hoursDiff > 6 && now.getHours() >= 10) {
      sleepContext = "NOTE: The user just replied after a long silence (likely sleep). Acknowledge that they are back/awake.";
    }
  }

  // 3. Save User Message
  await DB.addMessage('user', userMessage);

  // 4. Prepare Context
  const recentHistory = await DB.getRecentHistory();
  const userStats = await DB.getAffinity();

  const messages = [
    { role: "system", content: getSystemPrompt(userStats.affinity, sleepContext) },
    ...recentHistory.map(m => ({ role: m.role, content: m.content }))
  ];

  // 5. Generate
  await generateResponse(messages, chatId);
});

/**
 * AUTONOMOUS LOOP: Runs every 60 seconds
 */
setInterval(async () => {
  const now = new Date();
  const currentHour = now.getHours();

  // 1. QUIET HOURS (00:00 to 10:00)
  // Bot does not initiate conversation during these hours
  if (currentHour >= 0 && currentHour < 10) {
    return;
  }

  // 2. GET STATE
  const lastMsg = await DB.getLastMessage();
  const stats = await DB.getAffinity();

  // If we don't know who to talk to, or history is empty, do nothing
  if (!lastMsg || !stats.chat_id) return;

  // 3. BUSY STATUS CHECK
  if (stats.busy_until) {
    const busyTime = new Date(stats.busy_until);
    // If current time is strictly less than busy_until, we wait
    if (now < busyTime) {
      return; 
    }
    // Note: If now > busyTime, we proceed (busy time expired)
  }

  // 4. CHECK LAST MESSAGE AUTHOR
  // We only proactively message if the LAST message was from US (Assistant)
  // meaning the user hasn't replied yet.
  if (lastMsg.role === 'assistant') {
    const lastMsgTime = new Date(lastMsg.timestamp + "Z");
    const diffMinutes = (now - lastMsgTime) / (1000 * 60);

    // 5. TIMING LOGIC (10 Minute Rule)
    if (diffMinutes >= 10) {
      
      // Streak Logic (Max 3 autonomous messages)
      if (stats.msg_streak >= 3) {
        // EXCEPTION: Morning Reset
        // If it's been > 8 hours (480 mins) since last message, user probably slept.
        // We allow a "Good Morning" message even if streak was maxed last night.
        if (diffMinutes > 480) {
           await DB.updateStreak(0); // Reset streak for the new day
        } else {
           return; // Limit reached, stay silent
        }
      }

      // 6. DETERMINE PROMPT CONTEXT
      let autonomyPrompt = "The user hasn't replied in over 10 minutes.";
      
      // If significant time passed (morning scenario)
      if (currentHour >= 10 && diffMinutes > 400) {
        autonomyPrompt = "It is now past 10 AM. The user hasn't spoken since last night. Send a gentle morning greeting.";
      } else {
        autonomyPrompt += " Send a short message checking in, or changing the topic slightly. Do not be annoying.";
      }

      console.log(`[Autonomous] Triggering message. Streak: ${stats.msg_streak + 1}`);

      // 7. PREPARE & SEND
      const recentHistory = await DB.getRecentHistory();
      const messages = [
        { role: "system", content: getSystemPrompt(stats.affinity, autonomyPrompt) },
        ...recentHistory.map(m => ({ role: m.role, content: m.content }))
      ];

      await generateResponse(messages, stats.chat_id);
      
      // Increment streak
      DB.updateStreak(stats.msg_streak + 1);
    }
  }

}, 60 * 1000); // Check every 60 seconds

// Start Bot
console.log("Nano is initializing...");
bot.launch().then(() => {
  console.log("Nano is online and listening.");
}).catch(err => console.error("Failed to launch bot:", err));

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));