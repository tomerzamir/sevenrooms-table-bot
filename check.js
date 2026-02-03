const { chromium } = require('playwright');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Configuration from environment variables
const BOOKING_URL = process.env.BOOKING_URL;
const PARTY_SIZE = process.env.PARTY_SIZE;
const DATE = process.env.DATE;
const WINDOW_START = process.env.WINDOW_START; // Format: HH:MM
const WINDOW_END = process.env.WINDOW_END; // Format: HH:MM
const PUSHOVER_USER_KEY = process.env.PUSHOVER_USER_KEY;
const PUSHOVER_APP_TOKEN = process.env.PUSHOVER_APP_TOKEN;

const STATE_FILE = path.join(__dirname, 'state.json');

// Validate required environment variables
const requiredVars = {
  BOOKING_URL,
  PARTY_SIZE,
  DATE,
  WINDOW_START,
  WINDOW_END,
  PUSHOVER_USER_KEY,
  PUSHOVER_APP_TOKEN
};

const missingVars = Object.entries(requiredVars)
  .filter(([key, value]) => !value)
  .map(([key]) => key);

if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:');
  missingVars.forEach(v => console.error(`   - ${v}`));
  process.exit(1);
}

console.log('✅ Configuration loaded');
console.log(`   Booking URL: ${BOOKING_URL}`);
console.log(`   Party Size: ${PARTY_SIZE}`);
console.log(`   Date: ${DATE}`);
console.log(`   Time Window: ${WINDOW_START} - ${WINDOW_END}`);

// Load state file
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const content = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.warn('⚠️  Could not load state file, starting fresh');
  }
  return { notifiedTimes: [] };
}

// Save state file
function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('❌ Failed to save state:', error.message);
  }
}

// Convert time string (HH:MM) to minutes since midnight for comparison
function timeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

// Check if a time falls within the window
function isTimeInWindow(timeStr, windowStart, windowEnd) {
  const timeMinutes = timeToMinutes(timeStr);
  const startMinutes = timeToMinutes(windowStart);
  const endMinutes = timeToMinutes(windowEnd);
  return timeMinutes >= startMinutes && timeMinutes <= endMinutes;
}

// Format time to HH:MM
function formatTime(timeStr) {
  // Handle various time formats that SevenRooms might return
  // Examples: "19:30", "7:30 PM", "19:30:00", etc.
  const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})/);
  if (!timeMatch) return null;
  
  let hours = parseInt(timeMatch[1], 10);
  const minutes = parseInt(timeMatch[2], 10);
  
  // Handle PM times (if present)
  if (timeStr.toUpperCase().includes('PM') && hours < 12) {
    hours += 12;
  }
  if (timeStr.toUpperCase().includes('AM') && hours === 12) {
    hours = 0;
  }
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

// Send Pushover notification
async function sendNotification(time) {
  const message = `🍽️ Table available at ${time} on ${DATE} for ${PARTY_SIZE} people.`;
  
  try {
    const response = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token: PUSHOVER_APP_TOKEN,
        user: PUSHOVER_USER_KEY,
        message: message,
        title: 'SevenRooms Table Available',
        priority: 1,
      }),
    });

    const data = await response.json();
    
    if (data.status === 1) {
      console.log(`✅ Notification sent for ${time}`);
      return true;
    } else {
      console.error(`❌ Pushover error: ${data.errors?.join(', ') || 'Unknown error'}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Failed to send notification: ${error.message}`);
    return false;
  }
}

// Main checking function
async function checkAvailability() {
  const state = loadState();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const seenEndpoints = [];
  const availableTimes = [];
  let foundReservationData = false;

  // Intercept network responses
  page.on('response', async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';
    
    // Log interesting endpoints
    if (url.includes('sevenrooms') || url.includes('api') || contentType.includes('json')) {
      seenEndpoints.push(url);
      
      try {
        const json = await response.json().catch(() => null);
        if (json) {
          // Look for reservation/availability data
          // SevenRooms typically returns data in structures like:
          // - availability, slots, times, reservations, etc.
          const jsonStr = JSON.stringify(json).toLowerCase();
          
          if (jsonStr.includes('time') && (jsonStr.includes('available') || jsonStr.includes('slot') || jsonStr.includes('reservation'))) {
            foundReservationData = true;
            console.log(`📡 Found potential reservation data from: ${url}`);
            
            // Try to extract times from various possible structures
            const times = extractTimesFromJson(json);
            if (times.length > 0) {
              console.log(`   Found ${times.length} time slots`);
              availableTimes.push(...times);
            }
          }
        }
      } catch (error) {
        // Not JSON or parsing failed, ignore
      }
    }
  });

  try {
    console.log(`\n🌐 Loading booking page: ${BOOKING_URL}`);
    
    // Add random delay before loading (anti-bot)
    const delay = Math.floor(Math.random() * 5000) + 3000; // 3-8 seconds
    console.log(`⏳ Waiting ${delay}ms before loading...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // Load page with timeout
    await page.goto(BOOKING_URL, { 
      waitUntil: 'networkidle',
      timeout: 30000 
    });
    
    console.log('✅ Page loaded');
    
    // Wait for SevenRooms widget/iframe to load
    console.log('⏳ Waiting for SevenRooms widget to load...');
    
    // Try to find SevenRooms iframe or widget
    try {
      await page.waitForSelector('iframe[src*="sevenrooms"], iframe[src*="widget"], [data-sevenrooms], [id*="sevenrooms"]', {
        timeout: 15000
      }).catch(() => {
        console.log('⚠️  SevenRooms iframe selector not found, continuing...');
      });
    } catch (error) {
      console.log('⚠️  Could not find SevenRooms iframe, but continuing...');
    }
    
    // Wait a bit more for any async API calls
    await page.waitForTimeout(5000);
    
    console.log(`\n📊 Network activity summary:`);
    console.log(`   Total endpoints checked: ${seenEndpoints.length}`);
    if (seenEndpoints.length > 0) {
      console.log(`   Sample endpoints:`);
      seenEndpoints.slice(0, 5).forEach(url => {
        console.log(`     - ${url.substring(0, 80)}...`);
      });
    }
    
    if (!foundReservationData) {
      console.log('⚠️  No reservation data found in network responses');
      console.log('   This might mean:');
      console.log('   - The page structure has changed');
      console.log('   - The API endpoints are different');
      console.log('   - The widget loads differently');
    }
    
    // If we didn't find times via network interception, try DOM parsing
    if (availableTimes.length === 0) {
      console.log('\n🔍 Attempting to extract times from DOM...');
      const domTimes = await extractTimesFromDOM(page);
      if (domTimes.length > 0) {
        availableTimes.push(...domTimes);
        console.log(`   Found ${domTimes.length} times in DOM`);
      }
    }
    
    // Process available times
    if (availableTimes.length > 0) {
      console.log(`\n📅 Found ${availableTimes.length} available time slots:`);
      const uniqueTimes = [...new Set(availableTimes)];
      
      for (const time of uniqueTimes) {
        const formattedTime = formatTime(time);
        if (!formattedTime) {
          console.log(`   ⚠️  Could not parse time: ${time}`);
          continue;
        }
        
        console.log(`   - ${formattedTime}`);
        
        // Check if time is in window
        if (isTimeInWindow(formattedTime, WINDOW_START, WINDOW_END)) {
          const timeKey = `${DATE}_${formattedTime}`;
          
          // Check if we've already notified for this time
          if (!state.notifiedTimes.includes(timeKey)) {
            console.log(`   ✅ ${formattedTime} is in window! Sending notification...`);
            const sent = await sendNotification(formattedTime);
            
            if (sent) {
              state.notifiedTimes.push(timeKey);
              saveState(state);
            }
          } else {
            console.log(`   ℹ️  Already notified for ${formattedTime}, skipping`);
          }
        }
      }
    } else {
      console.log('\n❌ No available times found');
    }
    
  } catch (error) {
    console.error(`\n❌ Error during check: ${error.message}`);
    console.error(`   Stack: ${error.stack}`);
    
    // Retry once
    console.log('\n🔄 Retrying...');
    await browser.close();
    await new Promise(resolve => setTimeout(resolve, 2000));
    return checkAvailability();
  } finally {
    await browser.close();
  }
}

// Extract times from JSON response (handles various structures)
function extractTimesFromJson(json, times = []) {
  if (typeof json !== 'object' || json === null) return times;
  
  // Check common field names
  const timeFields = ['time', 'startTime', 'start_time', 'slot', 'availability', 'reservationTime'];
  
  for (const [key, value] of Object.entries(json)) {
    const lowerKey = key.toLowerCase();
    
    // If this looks like a time field
    if (timeFields.some(field => lowerKey.includes(field))) {
      if (typeof value === 'string' && value.match(/\d{1,2}:\d{2}/)) {
        times.push(value);
      }
    }
    
    // If this is an array, check each item
    if (Array.isArray(value)) {
      value.forEach(item => {
        if (typeof item === 'object') {
          extractTimesFromJson(item, times);
        } else if (typeof item === 'string' && item.match(/\d{1,2}:\d{2}/)) {
          times.push(item);
        }
      });
    }
    
    // Recursively check nested objects
    if (typeof value === 'object' && value !== null) {
      extractTimesFromJson(value, times);
    }
  }
  
  return times;
}

// Extract times from DOM as fallback
async function extractTimesFromDOM(page) {
  const times = [];
  
  try {
    // Look for common time selectors
    const selectors = [
      '[data-time]',
      '[class*="time"]',
      '[class*="slot"]',
      '[class*="availability"]',
      'button[aria-label*="time"]',
      '.time-slot',
      '.available-time'
    ];
    
    for (const selector of selectors) {
      const elements = await page.$$(selector);
      for (const element of elements) {
        const text = await element.textContent();
        if (text && text.match(/\d{1,2}:\d{2}/)) {
          times.push(text.trim());
        }
      }
    }
  } catch (error) {
    console.log(`   ⚠️  DOM extraction error: ${error.message}`);
  }
  
  return times;
}

// Run the check
console.log('🚀 Starting SevenRooms availability check...\n');
checkAvailability()
  .then(() => {
    console.log('\n✅ Check completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  });
