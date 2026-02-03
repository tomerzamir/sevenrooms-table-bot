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

// Select date in the booking widget
async function selectDate(page, targetDate) {
  try {
    // Parse the target date (format: YYYY-MM-DD)
    const [year, month, day] = targetDate.split('-').map(Number);
    const targetDateObj = new Date(year, month - 1, day);
    
    // Try various date picker selectors
    const dateInputSelectors = [
      'input[type="date"]',
      'input[placeholder*="date" i]',
      'input[name*="date" i]',
      '[data-testid*="date"]',
      '[class*="date-picker"]',
      '[class*="calendar"]',
      'button[aria-label*="date" i]'
    ];
    
    let dateSelected = false;
    
    // First, try to find a date input and set it directly
    for (const selector of dateInputSelectors) {
      try {
        const dateInput = await page.locator(selector).first();
        if (await dateInput.isVisible({ timeout: 2000 })) {
          console.log(`   Found date input with selector: ${selector}`);
          // Try to set the date directly if it's an input
          const tagName = await dateInput.evaluate(el => el.tagName.toLowerCase());
          if (tagName === 'input') {
            await dateInput.fill(targetDate);
            await dateInput.press('Enter');
            dateSelected = true;
            console.log(`✅ Set date input to ${targetDate}`);
            await page.waitForTimeout(1000);
            break;
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    // If direct input didn't work, try clicking on calendar dates
    if (!dateSelected) {
      console.log('   Trying calendar date selection...');
      
      // Look for calendar/date picker elements
      const calendarSelectors = [
        '[role="gridcell"]',
        '[class*="calendar-day"]',
        '[class*="date-cell"]',
        'td[data-date]',
        'button[data-date]',
        '[aria-label*="day"]'
      ];
      
      for (const selector of calendarSelectors) {
        try {
          // Get all date elements
          const dateElements = await page.locator(selector).all();
          
          for (const element of dateElements) {
            const text = await element.textContent();
            const ariaLabel = await element.getAttribute('aria-label') || '';
            const dataDate = await element.getAttribute('data-date') || '';
            
            // Check if this element matches our target date
            const elementDate = dataDate || ariaLabel || text;
            
            // Try to match the day number
            if (elementDate.includes(day.toString()) || text?.trim() === day.toString()) {
              // Verify it's the right month/year by checking parent context
              const parentText = await element.evaluate(el => {
                let parent = el.parentElement;
                let attempts = 0;
                while (parent && attempts < 5) {
                  const text = parent.textContent || '';
                  if (text.includes(month.toString()) || text.includes(year.toString())) {
                    return text;
                  }
                  parent = parent.parentElement;
                  attempts++;
                }
                return '';
              });
              
              // If we found a matching day, click it
              if (parentText.includes(month.toString()) || parentText.includes(year.toString()) || !parentText) {
                await element.click();
                dateSelected = true;
                console.log(`✅ Clicked date ${day} in calendar`);
                await page.waitForTimeout(2000);
                break;
              }
            }
          }
          
          if (dateSelected) break;
        } catch (error) {
          continue;
        }
      }
    }
    
    // If still not selected, try navigating calendar months
    if (!dateSelected) {
      console.log('   Trying to navigate calendar to target month...');
      
      // Try to find next/previous month buttons
      const navSelectors = [
        'button[aria-label*="next" i]',
        'button[aria-label*="previous" i]',
        'button[aria-label*="forward" i]',
        'button[aria-label*="back" i]',
        '[class*="next"]',
        '[class*="prev"]'
      ];
      
      // Get current month/year from calendar if visible
      const calendarText = await page.textContent('body');
      const currentMonth = new Date().getMonth() + 1;
      const currentYear = new Date().getFullYear();
      
      // Calculate how many months to navigate
      const monthsDiff = (year - currentYear) * 12 + (month - currentMonth);
      
      if (monthsDiff !== 0) {
        const navButton = monthsDiff > 0 
          ? await page.locator('button[aria-label*="next" i], button[aria-label*="forward" i]').first()
          : await page.locator('button[aria-label*="previous" i], button[aria-label*="back" i]').first();
        
        if (await navButton.isVisible({ timeout: 2000 })) {
          const clicks = Math.abs(monthsDiff);
          for (let i = 0; i < clicks; i++) {
            await navButton.click();
            await page.waitForTimeout(500);
          }
          console.log(`   Navigated ${clicks} month(s)`);
          
          // Now try to click the day
          const dayElements = await page.locator('[role="gridcell"], [class*="calendar-day"], button[data-date]').all();
          for (const element of dayElements) {
            const text = await element.textContent();
            if (text?.trim() === day.toString()) {
              await element.click();
              dateSelected = true;
              console.log(`✅ Clicked date ${day} after navigation`);
              await page.waitForTimeout(2000);
              break;
            }
          }
          return;
        }
      }
    }
    
    if (!dateSelected) {
      console.log('⚠️  Could not select date automatically, continuing...');
    }
  } catch (error) {
    console.log(`⚠️  Error selecting date: ${error.message}`);
  }
}

// Select party size in the booking widget
async function selectPartySize(page, partySize) {
  try {
    const partySizeNum = parseInt(partySize, 10);
    
    // Try various party size selectors
    const partySelectors = [
      `select[name*="party" i]`,
      `select[name*="guest" i]`,
      `select[name*="people" i]`,
      `input[name*="party" i]`,
      `input[name*="guest" i]`,
      `input[name*="people" i]`,
      `[data-testid*="party"]`,
      `[data-testid*="guest"]`,
      `button:has-text("${partySize}")`,
      `[aria-label*="party" i]`,
      `[aria-label*="guest" i]`
    ];
    
    let partySizeSelected = false;
    
    // Try to find and set party size input/select
    for (const selector of partySelectors) {
      try {
        const element = await page.locator(selector).first();
        if (await element.isVisible({ timeout: 2000 })) {
          console.log(`   Found party size element with selector: ${selector}`);
          
          const tagName = await element.evaluate(el => el.tagName.toLowerCase());
          
          if (tagName === 'select') {
            await element.selectOption(partySizeNum.toString());
            partySizeSelected = true;
            console.log(`✅ Selected party size ${partySize} from dropdown`);
            await page.waitForTimeout(1000);
            break;
          } else if (tagName === 'input') {
            await element.fill(partySizeNum.toString());
            await element.press('Enter');
            partySizeSelected = true;
            console.log(`✅ Set party size input to ${partySize}`);
            await page.waitForTimeout(1000);
            break;
          } else if (tagName === 'button') {
            await element.click();
            partySizeSelected = true;
            console.log(`✅ Clicked party size button for ${partySize}`);
            await page.waitForTimeout(1000);
            break;
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    // If not found, try increment/decrement buttons
    if (!partySizeSelected) {
      try {
        const incrementButtons = await page.locator('button[aria-label*="increase" i], button[aria-label*="increment" i], button[aria-label*="+" i]').all();
        const decrementButtons = await page.locator('button[aria-label*="decrease" i], button[aria-label*="decrement" i], button[aria-label*="-" i]').all();
        
        if (incrementButtons.length > 0 || decrementButtons.length > 0) {
          // Try to find current party size value
          const currentValueElement = await page.locator('input[type="number"], [class*="party"], [class*="guest"]').first();
          if (await currentValueElement.isVisible({ timeout: 2000 })) {
            const currentValue = parseInt(await currentValueElement.inputValue() || await currentValueElement.textContent() || '1', 10);
            const diff = partySizeNum - currentValue;
            
            if (diff !== 0) {
              const buttons = diff > 0 ? incrementButtons : decrementButtons;
              if (buttons.length > 0) {
                for (let i = 0; i < Math.abs(diff); i++) {
                  await buttons[0].click();
                  await page.waitForTimeout(300);
                }
                partySizeSelected = true;
                console.log(`✅ Adjusted party size to ${partySize} using buttons`);
              }
            } else {
              partySizeSelected = true;
              console.log(`✅ Party size already set to ${partySize}`);
            }
          }
        }
      } catch (error) {
        // Ignore errors
      }
    }
    
    if (!partySizeSelected) {
      console.log('⚠️  Could not select party size automatically, continuing...');
    }
  } catch (error) {
    console.log(`⚠️  Error selecting party size: ${error.message}`);
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
    
    // Click "Book a table" button
    console.log('🔘 Looking for "Book a table" button...');
    const bookButtonSelectors = [
      'button:has-text("Book a table")',
      'a:has-text("Book a table")',
      '[data-testid*="book"]',
      '[class*="book"]',
      'button[aria-label*="book"]',
      'a[href*="book"]',
      'button:has-text("Reserve")',
      'a:has-text("Reserve")',
      'button:has-text("Book")',
      'a:has-text("Book")'
    ];
    
    let bookButtonClicked = false;
    for (const selector of bookButtonSelectors) {
      try {
        const button = await page.locator(selector).first();
        if (await button.isVisible({ timeout: 3000 })) {
          console.log(`   Found button with selector: ${selector}`);
          await button.click();
          bookButtonClicked = true;
          console.log('✅ Clicked "Book a table" button');
          await page.waitForTimeout(2000); // Wait for modal/widget to appear
          break;
        }
      } catch (error) {
        // Try next selector
        continue;
      }
    }
    
    if (!bookButtonClicked) {
      console.log('⚠️  Could not find "Book a table" button, trying to continue...');
    }
    
    // Wait for SevenRooms widget/iframe to load
    console.log('⏳ Waiting for SevenRooms widget to load...');
    
    // Try to find SevenRooms iframe
    let iframe = null;
    try {
      const iframeElement = await page.waitForSelector('iframe[src*="sevenrooms"], iframe[src*="widget"], iframe[src*="booking"]', {
        timeout: 10000
      });
      if (iframeElement) {
        iframe = await iframeElement.contentFrame();
        console.log('✅ Found SevenRooms iframe');
      }
    } catch (error) {
      console.log('⚠️  SevenRooms iframe not found, using main page...');
    }
    
    // Use iframe context if available, otherwise use main page
    const contextPage = iframe || page;
    
    // Select the date
    console.log(`📅 Selecting date: ${DATE}`);
    await selectDate(contextPage, DATE);
    
    // Select party size
    console.log(`👥 Selecting party size: ${PARTY_SIZE}`);
    await selectPartySize(contextPage, PARTY_SIZE);
    
    // Wait a bit more for any async API calls after date and party size selection
    await page.waitForTimeout(3000);
    
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
      const domTimes = await extractTimesFromDOM(contextPage);
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
