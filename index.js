require('dotenv').config();
const fs = require('fs');
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const DB = require('./database');
const { toolsDefinition, availableTools } = require('./tools');
const { logDebug } = require('./logger'); 

// --- LOAD PERSONALITY FILES ---
let personalityCore = "";
let personalityFull = "";

try {
  personalityCore = fs.readFileSync('./personality_core.txt', 'utf8');
  personalityFull = fs.readFileSync('./personality_full.txt', 'utf8');
} catch (err) {
  console.error("Error loading personality files. Using defaults.");
  personalityCore = "You are Nano, a helpful assistant.";
  personalityFull = personalityCore;
}

// --- SETUP ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL_ID = process.env.GROQ_MODEL || "llama-3.2-11b-vision-preview";

// --- HELPER: SPECIAL DATES ---
const getSpecialEventContext = () => {
  const now = new Date();
  const today = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  
  const userBday = process.env.USER_BIRTHDAY || "";
  const botBday = process.env.BOT_BIRTHDAY || "";

  if (today === userBday) return "IMPORTANT: Today is the USER'S BIRTHDAY! 🎉";
  if (today === botBday) return "IMPORTANT: Today is YOUR (Nano's) BIRTHDAY! 🎂";

  const holidays = {
    "12-24": "Christmas Eve.",
    "12-25": "Christmas Day.",
    "12-31": "New Year's Eve.",
    "01-01": "New Year's Day.",
    "02-14": "Valentine's Day.",
    "10-31": "Halloween.",
  };
  if (holidays[today]) return `DATE CONTEXT: Today is ${holidays[today]}`;
  return "";
};

// --- HELPER: DIARY GENERATOR ---
async function writeDiaryEntry(affinity) {
  logDebug("SYSTEM", "Starting Diary Generation Process..."); 
  
  // NOTE: Interaction count is already reset by the caller now.
  
  const recentHistory = await DB.getRecentHistory(); 
  const conversationText = recentHistory.map(m => `${m.role}: ${m.content}`).join('\n');

  const diaryPrompt = [
    {
      role: "system",
      content: `You are Nano. Writing in private diary.
      PERSONALITY DEPTH: ${personalityFull}
      Affinity: ${affinity}
      Task: Write a SHORT, subjective diary entry (2-3 sentences) about recent interactions.
      - Be honest, introspective. Do NOT address the user.`
    },
    {
      role: "user",
      content: `Recent Logs:\n${conversationText}\n\nDear Diary,`
    }
  ];

  try {
    const completion = await groq.chat.completions.create({
      messages: diaryPrompt,
      model: "llama3-8b-8192", 
      temperature: 0.7,
    });

    const entry = completion.choices[0].message.content;
    if (entry) {
      DB.addDiaryEntry(entry);
      logDebug("DIARY_SAVED", entry);
    }
  } catch (err) {
    console.error("[Diary] Failed:", err);
    logDebug("DIARY_ERROR", err.message);
  }
}

// --- SYSTEM PROMPT ---
const getSystemPrompt = (affinity, diaryEntries, extraContext = "") => {
  let tone = "neutral";
  if (affinity > 50) tone = "loving";
  else if (affinity > 20) tone = "warm";
  else if (affinity < -50) tone = "annoyed";
  else if (affinity < -10) tone = "cold";

  const eventContext = getSpecialEventContext();
  
  const diaryContext = diaryEntries.length > 0 
    ? `DIARY (Internal Thoughts):\n${diaryEntries.map(e => `-${e.content}`).join('\n')}`
    : "";

  const now = new Date();
  const timeString = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  return `
  ID: ${personalityCore}
  STATE: Affinity ${affinity}/100 | Tone: ${tone} | Date: ${now.toDateString()} | Time: ${timeString}
  ${eventContext}
  ${diaryContext}
  ${extraContext}
  
  TOOLS:
  - 'google_search': News/facts.
  - 'set_busy_status': If user needs to leave.
  - 'recall_past_interactions': Memory.
  - 'update_emotional_state': React to compliment/insult (+1/-1).
  - Vision: Analyze images.
  
  Response Style: Concise, conversational Telegram messages.
  `;
};

// --- UPDATED GENERATE RESPONSE (Returns Success Boolean) ---
async function generateResponse(messages, chatId) {
  try {
    logDebug("LLM_REQUEST_START", "Sending request to Groq...");

    const completion = await groq.chat.completions.create({
      messages: messages,
      model: MODEL_ID,
      tools: toolsDefinition,
      tool_choice: "auto",
      temperature: 0.6, 
    });

    const responseMessage = completion.choices[0].message;
    let finalContent = responseMessage.content || "";

    logDebug("LLM_RAW_RESPONSE", {
      content: finalContent.substring(0, 50) + "...", 
      tool_calls: responseMessage.tool_calls ? "YES" : "NO"
    });

    // --- SANITIZER ---
    const jsonPattern = /(\{\s*"name":\s*"[\w_]+",\s*"parameters":\s*\{[\s\S]*?\}\s*\})/;
    const match = finalContent.match(jsonPattern);
    if (match) {
      logDebug("SANITIZER_TRIGGERED", "Caught hallucinated JSON."); 
      const jsonStr = match[0];
      finalContent = finalContent.replace(jsonStr, "").trim();
      try {
        const rawCall = JSON.parse(jsonStr);
        if (availableTools[rawCall.name]) {
          logDebug("SANITIZER_EXECUTE", rawCall.name);
          await availableTools[rawCall.name](rawCall.parameters);
        }
      } catch (err) {}
    }

    // --- REAL TOOL EXECUTION ---
    if (responseMessage.tool_calls) {
      messages.push(responseMessage); 
      for (const toolCall of responseMessage.tool_calls) {
        const fnName = toolCall.function.name;
        const fnArgs = JSON.parse(toolCall.function.arguments);
        logDebug("TOOL_EXECUTION", fnName);
        const toolOutput = await availableTools[fnName](fnArgs);
        messages.push({ tool_call_id: toolCall.id, role: "tool", name: fnName, content: toolOutput });
      }
      const secondResponse = await groq.chat.completions.create({
        messages: messages,
        model: MODEL_ID,
        temperature: 0.6,
      });
      finalContent = secondResponse.choices[0].message.content;
    }

    // --- SUCCESS CHECK ---
    if (finalContent) {
      await bot.telegram.sendMessage(chatId, finalContent);
      await DB.addMessage('assistant', finalContent);

      // 1. Increment (Async)
      await DB.incrementInteractionCount();
      
      // 2. Fetch Stats to check count
      const stats = await DB.getAffinity();
      
      // [LOG] Debug the counter to see if it's working
      logDebug("SYSTEM", `Interaction Count: ${stats.interaction_count} / 20`);

      if (stats.interaction_count >= 20) {
        // Reset immediately
        await DB.resetInteractionCount();
        logDebug("SYSTEM", "Limit reached! Resetting count and writing Diary.");
        writeDiaryEntry(stats.affinity);
      }
      return true; // Success
    }
    
    return false;

  } catch (error) {
    logDebug("FATAL_ERROR", error.message); 
    console.error("Gen Error:", error);
    return false; // <--- FAILURE (API Error)
  }
}

// --- USER HANDLER ---
bot.on(['text', 'photo'], async (ctx) => {
  const incomingUserId = String(ctx.from.id);
  const allowedId = process.env.ALLOWED_USER_ID;
  if (allowedId && incomingUserId !== allowedId) return;

  const chatId = ctx.chat.id;
  let userText = ctx.message.text || ctx.message.caption || "";
  
  if (userText.trim() === '/start') {
    logDebug("SYSTEM", "Ignored /start");
    return; 
  }

  let imageUrl = null;
  if (ctx.message.photo) {
    const largestPhoto = ctx.message.photo[ctx.message.photo.length - 1];
    try {
      const linkDetails = await ctx.telegram.getFileLink(largestPhoto.file_id);
      imageUrl = linkDetails.href;
    } catch (e) {}
  }

  logDebug("USER_INPUT", userText.substring(0, 30));

  DB.setChatId(chatId);
  DB.updateStreak(0);
  await DB.setBusyUntil(null);

  const lastMsg = await DB.getLastMessage();
  let sleepContext = "";
  if (lastMsg) {
    const lastDate = new Date(lastMsg.timestamp + "Z");
    const now = new Date();
    const hoursDiff = (now - lastDate) / (1000 * 60 * 60);
    if (hoursDiff > 6 && now.getHours() >= 10) sleepContext = "NOTE: User replied after sleep.";
  }

  const storedContent = imageUrl ? `[User sent an image] ${userText}` : userText;
  await DB.addMessage('user', storedContent);
  
  // NOTE: We do NOT increment here anymore, we increment only when the assistant successfully replies.
  // This prevents counting ignored messages or crashes.

  const recentHistory = await DB.getRecentHistory();
  const userStats = await DB.getAffinity();
  const diaryEntries = await DB.getRecentDiaryEntries(); 

  const systemMessage = { 
    role: "system", 
    content: getSystemPrompt(userStats.affinity, diaryEntries, sleepContext) 
  };

  const historyMessages = recentHistory.map(m => ({ role: m.role, content: m.content }));
  
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

  const finalMessages = [ systemMessage, ...historyMessages.slice(0, -1), currentMessage ];
  await generateResponse(finalMessages, chatId);
});

// --- AUTONOMOUS LOOP ---
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
        if (diffMinutes > 480) { await DB.updateStreak(0); stats.msg_streak = 0; } 
        else return; 
      }

      let autonomyInstruction = "";
      if (currentHour >= 10 && diffMinutes > 400) {
        const eventContext = getSpecialEventContext();
        autonomyInstruction = `TASK: Morning trigger. Event: ${eventContext}`;
      } else {
        switch (stats.msg_streak) {
          case 0: autonomyInstruction = "TASK: 10 mins passed. DISREGARD topic. Casual check-in."; break;
          case 1: autonomyInstruction = "TASK: 20 mins passed. Be insistent/curious."; break;
          case 2: autonomyInstruction = "TASK: 30 mins passed. Playful/Annoyed last attempt."; break;
          default: autonomyInstruction = "TASK: Check in.";
        }
      }

      logDebug("AUTONOMOUS_TRIGGER", { streak: stats.msg_streak });

      const recentHistory = await DB.getRecentHistory();
      const diaryEntries = await DB.getRecentDiaryEntries();
      const messages = [
        { role: "system", content: getSystemPrompt(stats.affinity, diaryEntries, autonomyInstruction) },
        ...recentHistory.map(m => ({ role: m.role, content: m.content }))
      ];

      // --- FIX: CHECK SUCCESS BEFORE UPDATING STREAK ---
      const success = await generateResponse(messages, stats.chat_id);
      
      if (success) {
        // Only increment streak if the message was ACTUALLY sent.
        // This resets the timestamp in DB, so diffMinutes will be ~0 next loop.
        await DB.updateStreak(stats.msg_streak + 1);
        logDebug("SYSTEM", "Autonomous message sent successfully. Streak updated.");
      } else {
        logDebug("SYSTEM", "Failed to send autonomous message. Will retry next minute.");
        // We do NOT increment streak. 
        // We do NOT update timestamp.
        // Loop will try again in 1 minute (Retry Logic).
      }
    }
  }
}, 60 * 1000);

// --- START ---
bot.launch().then(() => console.log(`Nano Online 🟢 | Model: ${MODEL_ID}`));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));