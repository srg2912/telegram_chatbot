// index.js
require('dotenv').config();
const fs = require('fs');
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const DB = require('./database');
const { toolsDefinition, availableTools } = require('./tools');

const bot = new Telegraf(process.env.BOT_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// 1. LOAD PERSONALITY
const personalityText = fs.readFileSync('./personality.txt', 'utf8');

const getSystemPrompt = (affinity, extraContext = "") => {
  let tone = "neutral";
  if (affinity > 50) tone = "loving and enthusiastic";
  else if (affinity < -50) tone = "hostile and annoyed";

  return `
  ${personalityText}
  
  Current Affinity: ${affinity} (-100 to 100).
  Tone: ${tone}.
  
  ${extraContext}
  
  Instructions:
  - Use 'recall_past_interactions' for memory.
  - Use 'update_emotional_state' to react to compliments/insults.
  - Keep it conversational.
  `;
};

// --- HELPER: GENERATE & SEND MESSAGE ---
async function generateResponse(messages, chatId) {
  try {
    const completion = await groq.chat.completions.create({
      messages: messages,
      model: "llama3-70b-8192",
      tools: toolsDefinition,
      tool_choice: "auto",
    });

    const responseMessage = completion.choices[0].message;
    let finalContent = responseMessage.content;

    // Handle Tools
    if (responseMessage.tool_calls) {
      messages.push(responseMessage); // Add tool request to history
      for (const toolCall of responseMessage.tool_calls) {
        const fnName = toolCall.function.name;
        const fnArgs = JSON.parse(toolCall.function.arguments);
        const toolOutput = await availableTools[fnName](fnArgs);
        
        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: fnName,
          content: toolOutput,
        });
      }
      // Second call after tools
      const secondResponse = await groq.chat.completions.create({
        messages: messages,
        model: "llama3-70b-8192",
      });
      finalContent = secondResponse.choices[0].message.content;
    }

    if (finalContent) {
      await bot.telegram.sendMessage(chatId, finalContent);
      await DB.addMessage('assistant', finalContent);
    }
  } catch (err) {
    console.error("Gen Error:", err);
  }
}

// --- USER INTERACTION HANDLER ---
bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  const chatId = ctx.chat.id;

  // Update DB with Chat ID and reset streak
  DB.setChatId(chatId);
  DB.updateStreak(0); // Reset autonomous streak because user replied
  
  // Check for "Sleep" Context
  const lastMsg = await DB.getLastMessage();
  let sleepContext = "";
  
  if (lastMsg) {
    const lastDate = new Date(lastMsg.timestamp); // UTC usually
    const now = new Date();
    
    // Convert to local hours (Simple check: if last msg was before 10AM today or yesterday)
    const hoursDiff = (now - lastDate) / (1000 * 60 * 60);
    
    // If > 6 hours passed and it's currently "daytime", assume sleep
    if (hoursDiff > 6 && now.getHours() >= 10) {
      sleepContext = "NOTE: The user just replied after a long silence (likely sleep). Acknowledge that they are back.";
    }
  }

  await DB.addMessage('user', userMessage);

  const recentHistory = await DB.getRecentHistory();
  const userStats = await DB.getAffinity();

  const messages = [
    { role: "system", content: getSystemPrompt(userStats.affinity, sleepContext) },
    ...recentHistory.map(m => ({ role: m.role, content: m.content })) // sanitize
  ];

  await generateResponse(messages, chatId);
});

// --- AUTONOMOUS HEARTBEAT (The 24/7 Logic) ---
setInterval(async () => {
  const now = new Date();
  const currentHour = now.getHours();

  // 1. Check Quiet Hours (00:00 to 10:00)
  // If it is between 0 and 9 (inclusive), we do NOT send messages.
  if (currentHour >= 0 && currentHour < 10) {
    return; 
  }

  // 2. GetData
  const lastMsg = await DB.getLastMessage();
  const stats = await DB.getAffinity();
  
  if (!lastMsg || !stats.chat_id) return; // No history or no known user

  // 3. Logic: Did the BOT send the last message?
  if (lastMsg.role === 'assistant') {
    const lastMsgTime = new Date(lastMsg.timestamp + "Z"); // Ensure UTC parsing
    const diffMinutes = (now - lastMsgTime) / (1000 * 60);

    // TRIGGER: If 10 minutes passed
    if (diffMinutes >= 10) {
      
      // Stop if we already annoyed the user 3 times
      if (stats.msg_streak >= 3) {
        // OPTIONAL: If it's specifically past 10AM and we haven't spoken since last night, 
        // we might want to reset the streak to say "Good morning".
        // Logic: If last message > 8 hours old, reset streak.
        if (diffMinutes > 480) { 
           await DB.updateStreak(0); // Allow morning greeting
        } else {
           return; // Maintain silence
        }
      }

      // Generate "Bored/Check-in" Prompt
      let autonomyPrompt = "The user hasn't replied in over 10 minutes.";
      
      // If it is the first message after 10 AM and last message was long ago
      if (currentHour >= 10 && diffMinutes > 400) {
        autonomyPrompt = "It is now past 10 AM. The user hasn't spoken since last night. Send a morning greeting.";
      } else {
        autonomyPrompt += " Send a short message checking in on them or changing the topic. Don't be too pushy.";
      }

      const recentHistory = await DB.getRecentHistory();
      const messages = [
        { role: "system", content: getSystemPrompt(stats.affinity, autonomyPrompt) },
        ...recentHistory.map(m => ({ role: m.role, content: m.content }))
      ];

      console.log(`Triggering autonomous message. Streak: ${stats.msg_streak + 1}`);
      
      await generateResponse(messages, stats.chat_id);
      
      // Increment streak
      DB.updateStreak(stats.msg_streak + 1);
    }
  }

}, 60 * 1000); // Run every 60 seconds

// Launch
bot.launch();
console.log("Nano is running with Personality & Autonomy...");

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));