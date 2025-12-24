require('dotenv').config();
const fs = require('fs');
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const DB = require('./database');
const { toolsDefinition, availableTools } = require('./tools');

// --- SETUP ---
const bot = new Telegraf(process.env.BOT_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL_ID = process.env.GROQ_MODEL || "llama-3.2-11b-vision-preview";

// Load Personality
let personalityText = "";
try {
  personalityText = fs.readFileSync('./personality.txt', 'utf8');
} catch (err) {
  personalityText = "You are a helpful assistant named Nano.";
}

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
// This runs in the background when interaction count hits 20
async function writeDiaryEntry(affinity) {
  console.log("[Diary] Writing new entry...");
  const recentHistory = await DB.getRecentHistory(); // Get context
  
  // Format history for the summarizer
  const conversationText = recentHistory.map(m => `${m.role}: ${m.content}`).join('\n');

  const diaryPrompt = [
    {
      role: "system",
      content: `You are Nano. You are writing in your private diary.
      
      Personality: ${personalityText}
      Current Affinity with User: ${affinity}.
      
      Task: Write a SHORT, subjective diary entry (2-3 sentences) about your recent interactions with the user.
      - Be honest about how you feel.
      - Are you annoyed? Happy? Bored?
      - Mention specific things the user said.
      - Do NOT address the user. This is for YOU only.`
    },
    {
      role: "user",
      content: `Here is the recent conversation logs:\n\n${conversationText}\n\nDear Diary,`
    }
  ];

  try {
    const completion = await groq.chat.completions.create({
      messages: diaryPrompt,
      model: "llama3-8b-8192", // Use a smaller/cheaper model for internal thought
      temperature: 0.7,
    });

    const entry = completion.choices[0].message.content;
    if (entry) {
      DB.addDiaryEntry(entry);
      DB.resetInteractionCount();
      console.log(`[Diary] Saved: "${entry}"`);
    }
  } catch (err) {
    console.error("[Diary] Failed to write:", err);
  }
}

// --- UPDATED SYSTEM PROMPT ---
// Now accepts 'diaryEntries' as an argument
const getSystemPrompt = (affinity, diaryEntries, extraContext = "") => {
  let tone = "neutral";
  if (affinity > 50) tone = "loving, enthusiastic, and affectionate";
  else if (affinity > 20) tone = "warm and friendly";
  else if (affinity < -50) tone = "hostile, short, and annoyed";
  else if (affinity < -10) tone = "cold and distant";

  const eventContext = getSpecialEventContext();
  
  const diaryContext = diaryEntries.length > 0 
    ? `YOUR PRIVATE DIARY (Last 10 entries - Internal monologue):\n${diaryEntries.map(e => `- [${e.timestamp}] ${e.content}`).join('\n')}`
    : "No diary entries yet.";

  return `
  ${personalityText}

  CURRENT STATUS:
  - Affinity: ${affinity} (-100 to 100).
  - Tone: ${tone}.
  - Date: ${new Date().toDateString()}.
  
  ${diaryContext}

  SPECIAL EVENTS:
  ${eventContext}
  
  CONTEXT NOTES:
  ${extraContext}
  
  INSTRUCTIONS:
  1. **VISION:** YOU HAVE FULL VISION. If sent an image, analyze it.
  2. **Search:** Use 'google_search' for news/facts.
  3. **Busy:** Use 'set_busy_status' if user leaves.
  4. **Memory:** Use 'recall_past_interactions' for past history.
  5. **Affinity:** Use 'update_emotional_state' if the user compliments or insults you. CHANGE MUST BE EXACTLY 1, -1, or 0.

  ⚠️ TOOL USAGE PROTOCOL (CRITICAL):
  - **DO NOT** write JSON or code blocks in your response text. 
  - **DO NOT** narrate the tool usage (e.g., do NOT write "*updates database*" or "*sets busy status*"). 
  - To use a tool, simply trigger the function call silently.
  - If you use a tool, do not output text in the same turn unless necessary.
  `;
};


// --- UPDATED GENERATE RESPONSE ---
async function generateResponse(messages, chatId) {
  try {
    // 1. Call Groq with lower temperature for stability
    const completion = await groq.chat.completions.create({
      messages: messages,
      model: MODEL_ID,
      tools: toolsDefinition,
      tool_choice: "auto",
      temperature: 0.6, // Lowered from default (1.0) to reduce hallucinations
    });

    const responseMessage = completion.choices[0].message;
    let finalContent = responseMessage.content || "";

    // --- SANITIZER: Catch hallucinated JSON in text ---
    // The regex looks for a JSON-like object structure at the end of the text
    const jsonPattern = /(\{\s*"name":\s*"[\w_]+",\s*"parameters":\s*\{[\s\S]*?\}\s*\})/;
    const match = finalContent.match(jsonPattern);

    if (match) {
      console.log("[Sanitizer] Caught hallucinated tool call in text. Fixing...");
      const jsonStr = match[0];
      
      // 1. Remove the JSON from the text shown to the user
      finalContent = finalContent.replace(jsonStr, "").trim();

      // 2. Attempt to execute the tool manually
      try {
        const rawCall = JSON.parse(jsonStr);
        if (availableTools[rawCall.name]) {
          console.log(`[Sanitizer] Manually executing: ${rawCall.name}`);
          // Execute but don't feed back to LLM to avoid loop, just save side effects
          await availableTools[rawCall.name](rawCall.parameters);
        }
      } catch (err) {
        console.error("[Sanitizer] Failed to parse/run hallucinated tool:", err);
      }
    }
    // --------------------------------------------------

    // 2. Handle REAL Tool Calls (The correct way)
    if (responseMessage.tool_calls) {
      messages.push(responseMessage); 

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

      // 3. Second Call to Groq
      const secondResponse = await groq.chat.completions.create({
        messages: messages,
        model: MODEL_ID,
        temperature: 0.6, // Keep temp low
      });
      
      finalContent = secondResponse.choices[0].message.content;
    }

    // 4. Send Response
    if (finalContent) {
      await bot.telegram.sendMessage(chatId, finalContent);
      await DB.addMessage('assistant', finalContent);

      // Diary Logic
      DB.incrementInteractionCount();
      const stats = await DB.getAffinity();
      if (stats.interaction_count >= 20) {
        writeDiaryEntry(stats.affinity);
      }
    }

  } catch (error) {
    console.error("Groq Generation Error:", error);
  }
}
// --- USER MESSAGE HANDLER ---
bot.on(['text', 'photo'], async (ctx) => {
  // Security Check
  const incomingUserId = String(ctx.from.id);
  const allowedId = process.env.ALLOWED_USER_ID;
  if (allowedId && incomingUserId !== allowedId) return;

  const chatId = ctx.chat.id;
  
  let userText = ctx.message.text || ctx.message.caption || "";
  let imageUrl = null;

  if (ctx.message.photo) {
    const largestPhoto = ctx.message.photo[ctx.message.photo.length - 1];
    try {
      const linkDetails = await ctx.telegram.getFileLink(largestPhoto.file_id);
      imageUrl = linkDetails.href;
    } catch (e) {}
  }

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

  const storedContent = imageUrl ? `[User sent an image] ${userText}` : userText;
  await DB.addMessage('user', storedContent);
  
  // Increment count after user speaks
  DB.incrementInteractionCount();

  // Load Context
  const recentHistory = await DB.getRecentHistory();
  const userStats = await DB.getAffinity();
  const diaryEntries = await DB.getRecentDiaryEntries(); // NEW: Fetch Diary

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

  const historyForContext = historyMessages.slice(0, -1);
  const finalMessages = [ systemMessage, ...historyForContext, currentMessage ];

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
        if (diffMinutes > 480) await DB.updateStreak(0); 
        else return; 
      }

      let autonomyPrompt = "User hasn't replied in 10 mins.";
      const eventContext = getSpecialEventContext();
      if (currentHour >= 10 && diffMinutes > 400) {
        autonomyPrompt = "Morning trigger.";
        if (eventContext) autonomyPrompt += " MENTION DATE.";
      } else {
        autonomyPrompt += " Check in.";
      }

      const recentHistory = await DB.getRecentHistory();
      const diaryEntries = await DB.getRecentDiaryEntries(); // NEW: Fetch Diary

      const messages = [
        { role: "system", content: getSystemPrompt(stats.affinity, diaryEntries, autonomyPrompt) },
        ...recentHistory.map(m => ({ role: m.role, content: m.content }))
      ];

      await generateResponse(messages, stats.chat_id);
      DB.updateStreak(stats.msg_streak + 1);
    }
  }
}, 60 * 1000);

// --- START ---
bot.launch().then(() => console.log(`Nano Online 🟢 | Model: ${MODEL_ID}`));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));