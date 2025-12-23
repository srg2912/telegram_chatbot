require('dotenv').config();
const fs = require('fs');
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const DB = require('./database');
const { toolsDefinition, availableTools } = require('./tools');

const bot = new Telegraf(process.env.BOT_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const model = process.env.MODEL || "";

// Load Personality
let personalityText = "";
try {
  personalityText = fs.readFileSync('./personality.txt', 'utf8');
} catch (err) {
  personalityText = "You are a helpful assistant named Nano.";
}

/**
 * NEW FUNCTION: Checks for Holidays & Birthdays
 * Returns a string with instructions if today is special.
 */
const getSpecialEventContext = () => {
  const now = new Date();
  // Format today as MM-DD
  const today = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  
  const userBday = process.env.USER_BIRTHDAY || "";
  const botBday = process.env.BOT_BIRTHDAY || "";

  // 1. Check Birthdays
  if (today === userBday) {
    return "IMPORTANT: Today is the USER'S BIRTHDAY! 🎉 You must be extra nice, celebrate them, and wish them a happy birthday.";
  }
  if (today === botBday) {
    return "IMPORTANT: Today is YOUR (Nano's) BIRTHDAY! 🎂 Act excited, mention it, and see if the user remembers.";
  }

  // 2. Check Static Holidays
  const holidays = {
    "12-24": "Christmas Eve. Wish the user a cozy evening.",
    "12-25": "Christmas Day. Wish the user a Merry Christmas!",
    "12-31": "New Year's Eve. Discuss plans for the new year.",
    "01-01": "New Year's Day. Wish the user a Happy New Year!",
    "02-14": "Valentine's Day. If affinity is high, be sweet. If low, be cynical about it.",
    "10-31": "Halloween. Get spooky!",
  };

  if (holidays[today]) {
    return `DATE CONTEXT: Today is ${holidays[today]}`;
  }

  return ""; // No special event
};

/**
 * UPDATED: System Prompt includes Special Events
 */
const getSystemPrompt = (affinity, extraContext = "") => {
  let tone = "neutral";
  if (affinity > 50) tone = "loving, enthusiastic, and affectionate";
  else if (affinity > 20) tone = "warm and friendly";
  else if (affinity < -50) tone = "hostile, short, and annoyed";
  else if (affinity < -10) tone = "cold and distant";

  // Get date context
  const eventContext = getSpecialEventContext();

  return `
  ${personalityText}

  CURRENT STATUS:
  - Affinity Level: ${affinity} (Range: -100 to 100).
  - Current Tone: ${tone}.
  - Date: ${new Date().toDateString()}.
  
  SPECIAL EVENT:
  ${eventContext}
  
  CONTEXT NOTES:
  ${extraContext}
  
  INSTRUCTIONS:
  1. **Internet Search:** Use 'google_search' for unknown facts/news.
  2. **Busy Status:** Use 'set_busy_status' if user is going away.
  3. **Memory:** Use 'recall_past_interactions' for past topics.
  4. **Affinity:** Use 'update_emotional_state' for compliments/insults.
  5. **Events:** If a Special Event is listed above, acknowledge it naturally (unless you already have in recent history).
  `;
};

// ... (Rest of the code remains the same: generateResponse, bot.on, setInterval) ...

async function generateResponse(messages, chatId) {
  try {
    const completion = await groq.chat.completions.create({
      messages: messages,
      model: model,
      tools: toolsDefinition,
      tool_choice: "auto",
    });

    const responseMessage = completion.choices[0].message;
    let finalContent = responseMessage.content;

    if (responseMessage.tool_calls) {
      messages.push(responseMessage);
      for (const toolCall of responseMessage.tool_calls) {
        const fnName = toolCall.function.name;
        const fnArgs = JSON.parse(toolCall.function.arguments);
        console.log(`[Tool Executed] ${fnName}`);
        const toolOutput = await availableTools[fnName](fnArgs);
        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: fnName,
          content: toolOutput,
        });
      }
      const secondResponse = await groq.chat.completions.create({
        messages: messages,
        model: model,
      });
      finalContent = secondResponse.choices[0].message.content;
    }

    if (finalContent) {
      await bot.telegram.sendMessage(chatId, finalContent);
      await DB.addMessage('assistant', finalContent);
    }
  } catch (error) {
    console.error("Gen Error:", error);
  }
}

bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  const chatId = ctx.chat.id;

  DB.setChatId(chatId);
  DB.updateStreak(0); 
  await DB.setBusyUntil(null); 

  const lastMsg = await DB.getLastMessage();
  let sleepContext = "";
  
  if (lastMsg) {
    const lastDate = new Date(lastMsg.timestamp + "Z");
    const now = new Date();
    const hoursDiff = (now - lastDate) / (1000 * 60 * 60);
    if (hoursDiff > 6 && now.getHours() >= 10) {
      sleepContext = "NOTE: User replied after a long silence (likely sleep).";
    }
  }

  await DB.addMessage('user', userMessage);

  const recentHistory = await DB.getRecentHistory();
  const userStats = await DB.getAffinity();

  const messages = [
    { role: "system", content: getSystemPrompt(userStats.affinity, sleepContext) },
    ...recentHistory.map(m => ({ role: m.role, content: m.content }))
  ];

  await generateResponse(messages, chatId);
});

setInterval(async () => {
  const now = new Date();
  const currentHour = now.getHours();

  if (currentHour >= 0 && currentHour < 10) return;

  const lastMsg = await DB.getLastMessage();
  const stats = await DB.getAffinity();
  
  if (!lastMsg || !stats.chat_id) return;
  if (stats.busy_until && now < new Date(stats.busy_until)) return;

  if (lastMsg.role === 'assistant') {
    const lastMsgTime = new Date(lastMsg.timestamp + "Z");
    const diffMinutes = (now - lastMsgTime) / (1000 * 60);

    if (diffMinutes >= 10) {
      if (stats.msg_streak >= 3) {
        if (diffMinutes > 480) await DB.updateStreak(0); 
        else return; 
      }

      // Check for special event string to influence the autonomous prompt
      const eventContext = getSpecialEventContext();
      let autonomyPrompt = "The user hasn't replied in over 10 minutes.";
      
      if (currentHour >= 10 && diffMinutes > 400) {
        autonomyPrompt = "It is now past 10 AM. Send a morning greeting.";
        // If today is a special event, prioritize that!
        if (eventContext) {
           autonomyPrompt += " AND MENTION THE SPECIAL EVENT/DATE!";
        }
      } else {
        autonomyPrompt += " Check in nicely.";
      }

      console.log(`[Autonomous] Triggering. Streak: ${stats.msg_streak + 1}`);

      const recentHistory = await DB.getRecentHistory();
      const messages = [
        { role: "system", content: getSystemPrompt(stats.affinity, autonomyPrompt) },
        ...recentHistory.map(m => ({ role: m.role, content: m.content }))
      ];

      await generateResponse(messages, stats.chat_id);
      DB.updateStreak(stats.msg_streak + 1);
    }
  }
}, 60 * 1000);

bot.launch().then(() => console.log("Nano Online 🟢"));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));