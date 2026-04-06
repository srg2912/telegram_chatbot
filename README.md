# Telegegram ChatBot

A sophisticated, autonomous Telegram companion bot powered by AI through an API. Nano features persistent memory, emotional intelligence (affinity system), autonomous check-ins, diary generation, and tool-augmented conversations.

## Features

- **🧠 AI Personality**: Context-aware responses with configurable personality depth via `personality_core.txt` and `personality_full.txt`
- **💕 Affinity System**: Dynamic emotional state tracking (-100 to +100) that influences tone and behavior
- **📔 Private Diary**: Automatically generates introspective diary entries every 20 interactions
- **🔍 Memory & Tools**: 
  - Long-term message search/recall
  - Google Custom Search integration for real-time information
  - Emotional state updates based on interactions
  - Busy status management
- **👁️ Vision Support**: Analyzes images sent by users
- **⏰ Autonomous Behavior**: Proactive check-ins after periods of inactivity (10-30 minute intervals)
- **🎂 Special Dates**: Recognizes birthdays and holidays configured in environment variables
- **🛡️ Access Control**: Restricts usage to specific Telegram user IDs
- **💾 Persistent Storage**: SQLite database for messages, stats, and diary entries

## Prerequisites

- Node.js 18+ 
- Telegram Bot Token (via [@BotFather](https://t.me/botfather))
- Groq API Key ([console.groq.com](https://console.groq.com))
- Google Programmable Search Engine (PSE) ID & API Key (optional, for search functionality)

## Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/srg2912/telegram_chatbot
   cd telegram_chatbot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create environment file**
   ```bash
   nano .env
   # Edit .env with your credentials
   ```

4. **Create personality files** (Required)
   ```bash
   echo "You are a helpful assistant." > personality_core.txt # Compressed form that will be passed on each interaction
   echo "You are a helpful and friendly AI companion." > personality_full.txt # Full text, passed only when creating chat summaries
   ```

5. **Start the bot**
   ```bash
   node index.js
   ```

## Configuration

Create a `.env` file in the root directory with the following variables:

| Variable | Description |
|----------|-------------|
| `BOT_TOKEN` | Telegram bot token from @BotFather |
| `GROQ_API_KEY` | API key from Groq console |
| `ALLOWED_USER_ID` | Telegram user ID authorized to use the bot |
| `GROQ_MODEL` | Model identifier (defaults to Llama 4 Maverick) |
| `PSE_ID` | Google Custom Search Engine ID |
| `PSE_API_KEY` | Google API key for search |
| `USER_BIRTHDAY` | User's birthday (MM-DD) |
| `BOT_BIRTHDAY` | Bot's birthday (MM-DD) |
| `PORT` | Express server port |

## Usage

Once running, the bot will:

1. **Respond to messages**: Reply to text and images with context-aware responses
2. **Track interactions**: Count successful exchanges and write diary entries every 20 interactions
3. **Autonomous check-ins**: Send proactive messages after:
   - 10 minutes (casual check-in)
   - 20 minutes (insistent/curious)
   - 30 minutes (playful/annoyed)
   - Morning greetings (after sleep detection)
4. **Use tools**: Automatically decide when to search the web, recall memories, or update emotional state
5. **Manage sleep**: Detect when users return after long periods and adjust context accordingly

### Commands

The bot interprets natural language. Available tools include:
- **Memory**: "Do you remember when we talked about..."
- **Search**: "Can you search for..."
- **Busy Status**: "I'll be gaming for 2 hours" → Sets busy status automatically
- **Emotional Updates**: Automatically adjusts affinity based on compliments/insults

## Project Structure

```
nano_bot/
├── index.js           # Main entry point, bot logic, autonomous loop
├── database.js        # SQLite wrapper for persistence
├── tools.js           # Tool definitions and implementations
├── logger.js          # Debug logging utility
├── personality_core.txt    # Core identity prompt
├── personality_full.txt    # Extended personality context
├── nano.db            # SQLite database (auto-created)
├── debug_log.txt      # Runtime logs (auto-created)
└── .env               # Environment configuration
```

## Architecture

- **Database**: SQLite with tables for messages, diary entries, and user statistics
- **State Management**: Tracks affinity, interaction counts, message streaks, and busy status
- **Autonomous Loop**: 1-minute interval checks for inactivity triggers
- **Sanitization**: Handles hallucinated JSON from LLM responses gracefully
- **Token Optimization**: Limits message history (10) and diary entries (3) to manage context window

## License

MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
