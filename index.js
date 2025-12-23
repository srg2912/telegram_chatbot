require('dotenv').config();
const fs = require('fs');
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const DB = require('./database');
const { toolsDefinition, availableTools } = require('./tools');

// --- INITIALIZATION ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL_ID = process.env.GROQ_MODEL || "llama-3.2-11b-vision-preview";

// --- LOAD PERSONALITY ---
let personalityText = "";
try {
  personalityText = fs.readFileSync('./personality.txt', 'utf8');
} catch (err) {
  console.error("Warning: personality.txt not found. Using default.");
  personalityText = "You are a helpful assistant named Nano.";
}

// --- HELPER: CHECK DATES & HOLIDAYS ---
const getSpecialEventContext = () => {
  const now = new Date();
  const today = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  
  const userBday = process.env.USER_BIRTHDAY || "";
  const botBday = process.env.BOT_BIRTHDAY || "";

  if (today === userBday) return "IMPORTANT: Today is the USER'S BIRTHDAY! 🎉 Celebrate them!";
  if (today === botBday) return "IMPORTANT: Today is YOUR (Nano's) BIRTHDAY! 🎂 Act excited!";

  const holidays = {
    "12-24": "Christmas Eve. Wish the user a cozy evening.",
    "12-25": "Christmas Day. Wish the user a Merry Christmas!",
    "12-31": "New Year's Eve. Discuss plans for the new year.",
    "01-01": "New Year's Day. Wish the user a Happy New Year!",
    "02-14": "Valentine's Day.",
    "10-31": "Halloween. Get spooky!",
  };

  if (holidays[today]) return `DATE CONTEXT: Today is ${holidays[today]}`;
  return "";
};

// --- HELPER: SYSTEM PROMPT GENERATOR ---
const getSystemPrompt = (affinity, extraContext = "") => {
  let tone = "neutral";
  if (affinity > 50) tone = "loving, enthusiastic, and affectionate";
  else if (affinity > 20) tone = "warm and friendly";
  else if (affinity < -50) tone = "hostile, short, and annoyed";
  else if (affinity < -10) tone = "cold and distant";

  const eventContext = getSpecialEventContext();

  return `
  ${personalityText}

  CURRENT STATUS:
  - Affinity Level: ${affinity} (Range: -100 to 100).
  - Current Tone: ${tone}.
  - Date: ${new Date().toDateString()}.
  
  SPECIAL EVENTS:
  ${eventContext}
  
  CONTEXT NOTES:
  ${extraContext}
  
  INSTRUCTIONS:
  1. **Internet Search:** Use 'google_search' for unknown facts/news.
  2. **Busy Status:** Use 'set_busy_status' if the user mentions going to do an activity (gaming, working, etc).
  3. **Memory:** Use 'recall_past_interactions' if the user asks about the past.
  4. **Affinity:** Use 'update_emotional_state' if the user compliments or insults you.
  5. **Vision:** If an image is provided, analyze it based on the user's text.
  `;
};

// --- CORE: GENERATE RESPONSE & HANDLE TOOLS ---
async function generateResponse(messages, chatId) {
  try {
    // 1. First Call to Groq
    const completion = await groq.chat.completions.create({
      messages: messages,
      model: MODEL_ID,
      tools: toolsDefinition,
      tool_choice: "auto",
    });

    const responseMessage = completion.choices[0].message;
    let finalContent = responseMessage.content;

    // 2. Handle Tool Calls
    if (responseMessage.tool_calls) {
      messages.push(responseMessage); // Add assistant's tool request to history

      for (const toolCall of responseMessage.tool_calls) {
        const fnName = toolCall.function.name;
        const fnArgs = JSON.parse(toolCall.function.arguments);
        
        console.log(`[Tool] Executing ${fnName}...`);
        
        const toolOutput = await availableTools[fnName](fnArgs);

        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: fnName,
          content: toolOutput,
        });
      }

      // 3. Second Call to Groq (With tool results)
      const secondResponse = await groq.chat.completions.create({
        messages: messages,
        model: MODEL_ID,
      });
      
      finalContent = secondResponse.choices[0].message.content;
    }

    // 4. Send Response
    if (finalContent) {
      await bot.telegram.sendMessage(chatId, finalContent);
      await DB.addMessage('assistant', finalContent);
    }

  } catch (error) {
    console.error("Groq Generation Error:", error);
    // Silent fail or notify user depending on preference
  }
}

// --- EVENT: USER MESSAGE (TEXT OR PHOTO) ---
bot.on(['text', 'photo'], async (ctx) => {
  const chatId = ctx.chat.id;

  // 1. Extract Content (Text & Image URL)
  let userText = ctx.message.text || ctx.message.caption || "";
  let imageUrl = null;

  if (ctx.message.photo) {
    // Get largest available photo
    const photoArray = ctx.message.photo;
    const largestPhoto = photoArray[photoArray.length - 1];
    try {
      const linkDetails = await ctx.telegram.getFileLink(largestPhoto.file_id);
      imageUrl = linkDetails.href;
    } catch (e) {
      console.error("Failed to fetch image link:", e);
    }
  }

  // 2. Update DB State
  DB.setChatId(chatId);
  DB.updateStreak(0); // Reset autonomous streak
  await DB.setBusyUntil(null); // Clear busy status

  // 3. Check for Sleep Context
  const lastMsg = await DB.getLastMessage();
  let sleepContext = "";
  if (lastMsg) {
    const lastDate = new Date(lastMsg.timestamp + "Z");
    const now = new Date();
    const hoursDiff = (now - lastDate) / (1000 * 60 * 60);
    // If silence > 6h and it's daytime (10am+), assume sleep
    if (hoursDiff > 6 && now.getHours() >= 10) {
      sleepContext = "NOTE: User just returned after a long silence (likely sleep). Welcome them back.";
    }
  }

  // 4. Save to Database (Text Representation Only)
  // We store a text marker for images so history remains lightweight
  const storedContent = imageUrl 
    ? `[User sent an image] ${userText}` 
    : userText;
  
  await DB.addMessage('user', storedContent);

  // 5. Prepare Payload for Groq
  const recentHistory = await DB.getRecentHistory();
  const userStats = await DB.getAffinity();

  const systemMessage = { 
    role: "system", 
    content: getSystemPrompt(userStats.affinity, sleepContext) 
  };

  // Convert DB history to standard message objects
  const historyMessages = recentHistory.map(m => ({ role: m.role, content: m.content }));

  // Create CURRENT message object (Multimodal if image exists)
  let currentMessage;
  if (imageUrl) {
    currentMessage = {
      role: "user",
      content: [
        { type: "text", text: userText || "Analyze this image." },
        { type: "image_url", image_url: { url: imageUrl } }
      ]
    };
  } else {
    currentMessage = { role: "user", content: userText };
  }

  // Combine: System + History (minus the text-entry we just saved) + Current (Rich)
  // We remove the last entry of historyMessages because it contains the text-only version 
  // of the message we are about to send in 'currentMessage'
  const historyForContext = historyMessages.slice(0, -1);

  const finalMessages = [
    systemMessage,
    ...historyForContext,
    currentMessage
  ];

  await generateResponse(finalMessages, chatId);
});

// --- AUTONOMOUS LOOP (Run every 60s) ---
setInterval(async () => {
  const now = new Date();
  const currentHour = now.getHours();

  // 1. Quiet Hours (00:00 - 10:00)
  if (currentHour >= 0 && currentHour < 10) return;

  const lastMsg = await DB.getLastMessage();
  const stats = await DB.getAffinity();

  // Validate state
  if (!lastMsg || !stats.chat_id) return;
  
  // Check Busy Status
  if (stats.busy_until) {
    if (now < new Date(stats.busy_until)) return; // Still busy
  }

  // 2. Autonomous Trigger Logic
  // Only trigger if WE (Assistant) sent the last message and user hasn't replied
  if (lastMsg.role === 'assistant') {
    const lastMsgTime = new Date(lastMsg.timestamp + "Z");
    const diffMinutes = (now - lastMsgTime) / (1000 * 60);

    // If 10 minutes have passed
    if (diffMinutes >= 10) {
      
      // Streak Check (Max 3 unreplied messages)
      if (stats.msg_streak >= 3) {
        // Exception: Morning Reset (if > 8 hours passed, assume new day)
        if (diffMinutes > 480) {
          await DB.updateStreak(0);
        } else {
          return; // Stop annoying the user
        }
      }

      // Generate Context
      let autonomyPrompt = "The user hasn't replied in over 10 minutes.";
      const eventContext = getSpecialEventContext();

      // Morning Trigger (First message after 10am with long gap)
      if (currentHour >= 10 && diffMinutes > 400) {
        autonomyPrompt = "It is now past 10 AM. Send a morning greeting.";
        if (eventContext) autonomyPrompt += " MENTION THE SPECIAL DATE TODAY.";
      } else {
        autonomyPrompt += " Send a short check-in message.";
      }

      console.log(`[Autonomous] Triggering. Streak: ${stats.msg_streak + 1}`);

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
}, 60 * 1000);

// --- STARTUP ---
bot.launch().then(() => {
  console.log(`Nano is Online 🟢 | Model: ${MODEL_ID}`);
}).catch((err) => {
  console.error("Failed to launch bot:", err);
});

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));