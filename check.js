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
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const monthName = monthNames[month - 1];
    
    // Wait a bit for the widget to fully load
    await page.waitForTimeout(1000);
    
    // Try various date picker selectors - clickable date fields
    const dateFieldSelectors = [
      'input[type="date"]',
      'input[placeholder*="date" i]',
      'input[name*="date" i]',
      '[data-testid*="date"]',
      '[class*="date"]',
      '[class*="Date"]',
      'button[aria-label*="date" i]',
      'div[role="button"][aria-label*="date" i]',
      '[id*="date"]',
      'input[readonly]', // SevenRooms often uses readonly inputs
      'div:has-text("Date")',
      'label:has-text("Date")'
    ];
    
    let dateSelected = false;
    
    // First, try to find and click the date field to open calendar
    for (const selector of dateFieldSelectors) {
      try {
        const dateField = await page.locator(selector).first();
        if (await dateField.isVisible({ timeout: 2000 })) {
          console.log(`   Found date field with selector: ${selector}`);
          
          const tagName = await dateField.evaluate(el => el.tagName.toLowerCase());
          
          // If it's an input, try to fill it directly first
          if (tagName === 'input') {
            try {
              await dateField.fill(targetDate);
              await dateField.press('Enter');
              await page.waitForTimeout(1000);
              dateSelected = true;
              console.log(`✅ Set date input to ${targetDate}`);
              break;
            } catch (error) {
              // If that fails, try clicking to open calendar
              console.log(`   Input fill failed, trying to click to open calendar...`);
            }
          }
          
          // Click to open calendar
          await dateField.click();
          await page.waitForTimeout(1500); // Wait for calendar to open
          console.log(`   Clicked date field, calendar should be open`);
          break;
        }
      } catch (error) {
        continue;
      }
    }
    
    // If direct input didn't work, try clicking on calendar dates
    if (!dateSelected) {
      console.log('   Trying calendar date selection...');
      
      // First, check current month/year displayed and navigate if needed
      const pageText = await page.textContent('body');
      console.log(`   Current calendar context: ${pageText.substring(0, 200)}...`);
      
      // Try to navigate to the correct month/year first
      const currentMonth = new Date().getMonth() + 1;
      const currentYear = new Date().getFullYear();
      const monthsDiff = (year - currentYear) * 12 + (month - currentMonth);
      
      if (monthsDiff !== 0) {
        console.log(`   Need to navigate ${monthsDiff > 0 ? 'forward' : 'back'} ${Math.abs(monthsDiff)} month(s)`);
        
        const navSelectors = [
          'button[aria-label*="next" i]',
          'button[aria-label*="Next" i]',
          'button[aria-label*="forward" i]',
          'button[aria-label*=">" i]',
          '[class*="next"]',
          '[class*="Next"]',
          'button:has-text(">")',
          'button:has-text("›")',
          'button:has-text("→")'
        ];
        
        const prevSelectors = [
          'button[aria-label*="previous" i]',
          'button[aria-label*="Previous" i]',
          'button[aria-label*="back" i]',
          'button[aria-label*="<" i]',
          '[class*="prev"]',
          '[class*="Prev"]',
          'button:has-text("<")',
          'button:has-text("‹")',
          'button:has-text("←")'
        ];
        
        const navButtons = monthsDiff > 0 ? navSelectors : prevSelectors;
        
        for (const navSelector of navButtons) {
          try {
            const navButton = await page.locator(navSelector).first();
            if (await navButton.isVisible({ timeout: 2000 })) {
              const clicks = Math.abs(monthsDiff);
              for (let i = 0; i < clicks; i++) {
                await navButton.click();
                await page.waitForTimeout(800); // Wait for calendar to update
              }
              console.log(`   ✅ Navigated ${clicks} month(s)`);
              await page.waitForTimeout(1000);
              break;
            }
          } catch (error) {
            continue;
          }
        }
      }
      
      // Now try to find and click the day
      const calendarSelectors = [
        `button:has-text("${day}")`,
        `[aria-label*="${day}" i]`,
        `[data-date*="${targetDate}"]`,
        `[data-date*="${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}"]`,
        '[role="gridcell"]',
        '[class*="calendar-day"]',
        '[class*="date-cell"]',
        'td[data-date]',
        'button[data-date]',
        '[aria-label*="day" i]',
        'div[role="button"]'
      ];
      
      for (const selector of calendarSelectors) {
        try {
          const dateElements = await page.locator(selector).all();
          console.log(`   Found ${dateElements.length} elements with selector: ${selector}`);
          
          for (const element of dateElements) {
            const text = await element.textContent();
            const ariaLabel = await element.getAttribute('aria-label') || '';
            const dataDate = await element.getAttribute('data-date') || '';
            const isDisabled = await element.getAttribute('disabled') || await element.getAttribute('aria-disabled') === 'true';
            
            if (isDisabled) continue;
            
            // Check if this element matches our target date
            const elementDate = dataDate || ariaLabel || text || '';
            
            // Try to match the day number - be more flexible
            const dayMatch = text?.trim() === day.toString() || 
                           text?.trim() === `0${day}` ||
                           elementDate.includes(day.toString());
            
            if (dayMatch) {
              // Check if it's in the right month context
              const parentText = await element.evaluate(el => {
                let parent = el.parentElement;
                let attempts = 0;
                let fullContext = '';
                while (parent && attempts < 10) {
                  const text = parent.textContent || '';
                  fullContext += text + ' ';
                  parent = parent.parentElement;
                  attempts++;
                }
                return fullContext;
              });
              
              // Check if parent context mentions the month/year
              const hasMonth = parentText.includes(monthName) || 
                              parentText.includes(month.toString()) ||
                              parentText.includes(monthNames[month - 1].substring(0, 3));
              
              // If data-date attribute exists and matches, that's definitive
              if (dataDate && dataDate.includes(targetDate)) {
                await element.click();
                dateSelected = true;
                console.log(`✅ Clicked date ${day} (matched by data-date: ${dataDate})`);
                await page.waitForTimeout(2000);
                break;
              } else if (hasMonth || !parentText) {
                // Try clicking if month matches or if we can't determine context
                await element.click();
                dateSelected = true;
                console.log(`✅ Clicked date ${day} (matched by text: ${text})`);
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
    
    if (!dateSelected) {
      console.log('⚠️  Could not select date automatically, continuing...');
      console.log('   The script will continue but may not find availability for the selected date');
    }
  } catch (error) {
    console.log(`⚠️  Error selecting date: ${error.message}`);
  }
}

// Select party size in the booking widget
async function selectPartySize(page, partySize) {
  try {
    const partySizeNum = parseInt(partySize, 10);
    
    // Wait a bit for widget to be ready
    await page.waitForTimeout(500);
    
    // Try various party size selectors - be more comprehensive
    const partySelectors = [
      `select[name*="party" i]`,
      `select[name*="guest" i]`,
      `select[name*="people" i]`,
      `select[name*="guests" i]`,
      `input[name*="party" i]`,
      `input[name*="guest" i]`,
      `input[name*="people" i]`,
      `input[name*="guests" i]`,
      `input[type="number"]`,
      `[data-testid*="party"]`,
      `[data-testid*="guest"]`,
      `[id*="party"]`,
      `[id*="guest"]`,
      `[class*="party"]`,
      `[class*="guest"]`,
      `[class*="Guest"]`,
      `button:has-text("${partySize}")`,
      `[aria-label*="party" i]`,
      `[aria-label*="guest" i]`,
      `[aria-label*="Guests" i]`,
      `label:has-text("Guest")`,
      `label:has-text("guests")`,
      `div:has-text("Guests")`
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
            try {
              await element.selectOption(partySizeNum.toString());
              partySizeSelected = true;
              console.log(`✅ Selected party size ${partySize} from dropdown`);
              await page.waitForTimeout(1000);
              break;
            } catch (error) {
              console.log(`   Select option failed: ${error.message}`);
              continue;
            }
          } else if (tagName === 'input') {
            try {
              // Clear first, then fill
              await element.click();
              await element.fill('');
              await element.fill(partySizeNum.toString());
              await element.press('Enter');
              await page.waitForTimeout(500);
              
              // Verify it was set
              const value = await element.inputValue();
              if (value === partySizeNum.toString()) {
                partySizeSelected = true;
                console.log(`✅ Set party size input to ${partySize}`);
                await page.waitForTimeout(1000);
                break;
              }
            } catch (error) {
              console.log(`   Input fill failed: ${error.message}`);
              continue;
            }
          } else if (tagName === 'button' || tagName === 'div') {
            // For buttons/divs, try clicking
            try {
              await element.click();
              partySizeSelected = true;
              console.log(`✅ Clicked party size element for ${partySize}`);
              await page.waitForTimeout(1000);
              break;
            } catch (error) {
              continue;
            }
          } else if (tagName === 'label') {
            // If it's a label, try to find associated input
            try {
              const forAttr = await element.getAttribute('for');
              if (forAttr) {
                const input = await page.locator(`#${forAttr}`).first();
                if (await input.isVisible({ timeout: 1000 })) {
                  await input.fill(partySizeNum.toString());
                  await input.press('Enter');
                  partySizeSelected = true;
                  console.log(`✅ Set party size via label to ${partySize}`);
                  await page.waitForTimeout(1000);
                  break;
                }
              }
            } catch (error) {
              continue;
            }
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    // If not found, try increment/decrement buttons
    if (!partySizeSelected) {
      console.log('   Trying increment/decrement buttons...');
      try {
        const incrementSelectors = [
          'button[aria-label*="increase" i]',
          'button[aria-label*="increment" i]',
          'button[aria-label*="+" i]',
          'button:has-text("+")',
          '[class*="increment"]',
          '[class*="increase"]'
        ];
        
        const decrementSelectors = [
          'button[aria-label*="decrease" i]',
          'button[aria-label*="decrement" i]',
          'button[aria-label*="-" i]',
          'button:has-text("-")',
          '[class*="decrement"]',
          '[class*="decrease"]'
        ];
        
        let incrementButton = null;
        let decrementButton = null;
        
        for (const selector of incrementSelectors) {
          try {
            const btn = await page.locator(selector).first();
            if (await btn.isVisible({ timeout: 1000 })) {
              incrementButton = btn;
              break;
            }
          } catch (error) {
            continue;
          }
        }
        
        for (const selector of decrementSelectors) {
          try {
            const btn = await page.locator(selector).first();
            if (await btn.isVisible({ timeout: 1000 })) {
              decrementButton = btn;
              break;
            }
          } catch (error) {
            continue;
          }
        }
        
        if (incrementButton || decrementButton) {
          // Try to find current party size value
          const valueSelectors = [
            'input[type="number"]',
            '[class*="party"]',
            '[class*="guest"]',
            '[class*="value"]',
            '[data-value]'
          ];
          
          let currentValue = 1;
          for (const selector of valueSelectors) {
            try {
              const valueElement = await page.locator(selector).first();
              if (await valueElement.isVisible({ timeout: 1000 })) {
                const tagName = await valueElement.evaluate(el => el.tagName.toLowerCase());
                if (tagName === 'input') {
                  currentValue = parseInt(await valueElement.inputValue() || '1', 10);
                } else {
                  currentValue = parseInt(await valueElement.textContent() || '1', 10);
                }
                console.log(`   Current party size: ${currentValue}`);
                break;
              }
            } catch (error) {
              continue;
            }
          }
          
          const diff = partySizeNum - currentValue;
          
          if (diff !== 0) {
            const button = diff > 0 ? incrementButton : decrementButton;
            if (button) {
              const clicks = Math.abs(diff);
              for (let i = 0; i < clicks; i++) {
                await button.click();
                await page.waitForTimeout(400);
              }
              partySizeSelected = true;
              console.log(`✅ Adjusted party size to ${partySize} using ${diff > 0 ? 'increment' : 'decrement'} buttons`);
            }
          } else {
            partySizeSelected = true;
            console.log(`✅ Party size already set to ${partySize}`);
          }
        }
      } catch (error) {
        console.log(`   Button adjustment failed: ${error.message}`);
      }
    }
    
    if (!partySizeSelected) {
      console.log('⚠️  Could not select party size automatically, continuing...');
      console.log('   The script will continue but may not find correct availability');
    }
  } catch (error) {
    console.log(`⚠️  Error selecting party size: ${error.message}`);
  }
}

// Extract times recursively from data structure, optionally filtered by date
function extractTimes(data, times = new Set(), visited = new WeakSet(), filterDate = null) {
  if (data === null || data === undefined) return times;
  
  // Avoid circular references (only for objects)
  if (typeof data === 'object' && data !== null) {
    if (visited.has(data)) return times;
    visited.add(data);
  }
  
  // Handle arrays
  if (Array.isArray(data)) {
    data.forEach(item => extractTimes(item, times, visited));
    return times;
  }
  
  // Handle objects
  if (typeof data === 'object') {
    // Check common time-related keys
    const timeKeys = ['time', 'times', 'slots', 'available_times', 'start_time', 'startTime', 'slot', 'availability', 'reservationTime'];
    
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      
      // If key suggests time data, process it
      if (timeKeys.some(tk => lowerKey.includes(tk.toLowerCase()))) {
        extractTimes(value, times, visited);
      }
      
      // Recursively process all values
      extractTimes(value, times, visited);
    }
    
    return times;
  }
  
  // Handle strings
  if (typeof data === 'string') {
    // Match HH:MM format
    const timeMatch = data.match(/\b(\d{1,2}):(\d{2})\b/);
    if (timeMatch) {
      const hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
        const formattedTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
        times.add(formattedTime);
      }
    }
    
    // Match ISO datetime strings
    const isoMatch = data.match(/\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):/);
    if (isoMatch) {
      const hours = parseInt(isoMatch[1], 10);
      const minutes = parseInt(isoMatch[2], 10);
      const formattedTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
      times.add(formattedTime);
    }
  }
  
  return times;
}

// Check if a JSON response contains times for the selected date
function hasTimesForDate(json, selectedDate) {
  if (!json || typeof json !== 'object') return false;
  
  const jsonStr = JSON.stringify(json).toLowerCase();
  const [year, month, day] = selectedDate.split('-').map(Number);
  const dateStr = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  const dateStrAlt = `${month}/${day}/${year}`;
  const dateStrAlt2 = `${day}/${month}/${year}`;
  
  // Check if the JSON contains the selected date
  return jsonStr.includes(dateStr) || 
         jsonStr.includes(dateStrAlt) || 
         jsonStr.includes(dateStrAlt2) ||
         jsonStr.includes(`${day} ${['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][month - 1]}`);
}

// Main checking function
async function checkAvailability() {
  const state = loadState();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const relevantUrls = [];
  const jsonResponses = [];
  const allExtractedTimes = new Set();

  // Monitor network responses from main page
  page.on('response', async (response) => {
    const url = response.url();
    const urlLower = url.toLowerCase();
    
    // Check if URL matches our patterns
    const urlPatterns = ['sevenrooms', 'availability', 'reservation', 'search', 'slot', 'booking', 'inventory'];
    const matchesPattern = urlPatterns.some(pattern => urlLower.includes(pattern));
    
    if (matchesPattern && relevantUrls.length < 50) {
      relevantUrls.push(url);
      console.log(`📡 [${relevantUrls.length}/50] ${url}`);
      
      // Try to parse as JSON
      try {
        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('json') || urlLower.includes('.json')) {
          const json = await response.json().catch(() => null);
          if (json) {
            jsonResponses.push({ url, data: json });
            // Only extract times if this response is for the selected date
            if (hasTimesForDate(json, DATE)) {
              const times = extractTimes(json);
              times.forEach(time => allExtractedTimes.add(time));
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
    
    // Wait for page to be fully interactive
    await page.waitForTimeout(2000);
    
    // First, click "BOOK A TABLE" button to open the booking widget
    console.log('🔘 Clicking "BOOK A TABLE" button...');
    const bookTableSelectors = [
      'a:has-text("BOOK A TABLE")',
      'a:has-text("Book a table")',
      'button:has-text("BOOK A TABLE")',
      'button:has-text("Book a table")',
      'a[href*="sevenrooms"]',
      'a[href*="reservations"]',
      '[class*="book"]',
      'a:has-text("Book")',
      'button:has-text("Book")'
    ];
    
    let bookTableClicked = false;
    for (const selector of bookTableSelectors) {
      try {
        const bookButton = await page.locator(selector).first();
        if (await bookButton.isVisible({ timeout: 3000 })) {
          console.log(`   Found "BOOK A TABLE" button with selector: ${selector}`);
          
          // Click and wait for navigation if it's a link
          const href = await bookButton.getAttribute('href').catch(() => null);
          if (href) {
            // It's a link that will navigate - wait for navigation
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {}),
              bookButton.click()
            ]);
            console.log('✅ Clicked "BOOK A TABLE" button and navigated');
            bookTableClicked = true;
          } else {
            // It's a button - just click it
            await bookButton.click();
            console.log('✅ Clicked "BOOK A TABLE" button');
            bookTableClicked = true;
            await page.waitForTimeout(3000);
          }
          break;
        }
      } catch (error) {
        continue;
      }
    }
    
    if (!bookTableClicked) {
      console.log('⚠️  Could not find "BOOK A TABLE" button, trying to continue...');
    }
    
    // Wait for booking page/widget to fully load
    console.log('⏳ Waiting for booking page to load...');
    await page.waitForTimeout(3000);
    
    // Wait for SevenRooms iframe to load - this is critical!
    console.log('⏳ Waiting for SevenRooms iframe to load...');
    let iframe = null;
    let targetPage = page;
    
    try {
      const iframeElement = await page.waitForSelector('iframe[src*="sevenrooms"], iframe[src*="widget"], iframe[src*="booking"], iframe[title*="Reservation"]', {
        timeout: 15000
      });
      if (iframeElement) {
        iframe = await iframeElement.contentFrame();
        if (iframe) {
          console.log('✅ Found SevenRooms iframe');
          targetPage = iframe;
          
          // Wait for iframe content to be ready
          console.log('⏳ Waiting for iframe content to be ready...');
          await iframe.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(3000);
          
          // Wait for the date button to appear INSIDE the iframe
          console.log('⏳ Waiting for date button inside iframe...');
          try {
            await iframe.waitForSelector('[data-test="sr-reservation-date"], button[aria-label*="Date"], button[aria-label*="date" i]', {
              timeout: 10000
            });
            console.log('✅ Date button found inside iframe!');
          } catch (error) {
            console.log('⚠️  Date button not found in iframe yet, will try anyway...');
          }
        }
      }
    } catch (error) {
      console.log('⚠️  SevenRooms iframe not found, will try main page...');
    }
    
    // Click the date button to open calendar
    console.log(`📅 Clicking date button to select date: ${DATE}`);
    const [year, month, day] = DATE.split('-').map(Number);
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const monthName = monthNames[month - 1];
    const monthNameShort = monthName.substring(0, 3); // "Feb"
    
    // Try to find and click the date button
    const dateButtonSelectors = [
      '[data-test="sr-reservation-date"]',
      'button[data-test="sr-reservation-date"]',
      'button[aria-label*="Date"]',
      'button[aria-label*="date" i]',
      '[data-testid*="date"]',
      'button:has-text("Date")',
      'button[class*="date"]',
      '[role="button"][aria-label*="date" i]'
    ];
    
    let dateButtonClicked = false;
    
    // Try the target page (iframe if found, otherwise main page)
    const pagesToTry = targetPage === iframe ? [iframe, page] : [page];
    
    for (const testPage of pagesToTry) {
      const pageName = testPage === page ? 'main page' : 'iframe';
      console.log(`   Searching for date button on ${pageName}...`);
      
      for (const selector of dateButtonSelectors) {
        try {
          const dateButton = await testPage.locator(selector).first();
          if (await dateButton.isVisible({ timeout: 3000 })) {
            const ariaLabel = await dateButton.getAttribute('aria-label') || '';
            const text = await dateButton.textContent() || '';
            console.log(`   ✅ Found date button on ${pageName} with selector: ${selector}`);
            console.log(`      aria-label: "${ariaLabel}", text: "${text}"`);
            await dateButton.click();
            dateButtonClicked = true;
            targetPage = testPage; // Remember which page we used
            console.log('✅ Clicked date button, waiting for calendar to open...');
            await page.waitForTimeout(2000);
            break;
          }
        } catch (error) {
          continue;
        }
      }
      
      if (dateButtonClicked) break;
      
      // Try alternative approach - look for buttons with date-like text
      try {
        const allButtons = await testPage.locator('button').all();
        console.log(`   Checking ${allButtons.length} buttons on ${pageName}...`);
        for (const btn of allButtons) {
          try {
            const ariaLabel = await btn.getAttribute('aria-label') || '';
            const text = await btn.textContent() || '';
            const dataTest = await btn.getAttribute('data-test') || '';
            
            if (dataTest.includes('date') || 
                ariaLabel.toLowerCase().includes('date') || 
                (text && (text.toLowerCase().includes('date') || text.match(/\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i)))) {
              console.log(`   Found potential date button: aria-label="${ariaLabel}", text="${text}", data-test="${dataTest}"`);
              await btn.click();
              dateButtonClicked = true;
              targetPage = testPage; // Remember which page we used
              console.log(`✅ Clicked date button on ${pageName} via alternative match`);
              await page.waitForTimeout(2000);
              break;
            }
          } catch (error) {
            continue;
          }
        }
      } catch (error) {
        console.log(`   Error checking buttons on ${pageName}: ${error.message}`);
      }
      
      if (dateButtonClicked) break;
    }
    
    if (!dateButtonClicked) {
      console.log('❌ Could not find date button on any page!');
      console.log('   Attempting to continue anyway...');
    }
    
    if (dateButtonClicked) {
      // Navigate to target month/year if needed
      const currentMonth = new Date().getMonth() + 1;
      const currentYear = new Date().getFullYear();
      const monthsDiff = (year - currentYear) * 12 + (month - currentMonth);
      
      if (monthsDiff !== 0) {
        console.log(`   Navigating ${monthsDiff > 0 ? 'forward' : 'back'} ${Math.abs(monthsDiff)} month(s)...`);
        
        const navSelectors = monthsDiff > 0 
          ? ['button[aria-label*="next" i]', 'button[aria-label*="Next" i]', 'button:has-text(">")', 'button:has-text("›")']
          : ['button[aria-label*="previous" i]', 'button[aria-label*="Previous" i]', 'button:has-text("<")', 'button:has-text("‹")'];
        
        for (const navSelector of navSelectors) {
          try {
            const navButton = await targetPage.locator(navSelector).first();
            if (await navButton.isVisible({ timeout: 2000 })) {
              const clicks = Math.abs(monthsDiff);
              for (let i = 0; i < clicks; i++) {
                await navButton.click();
                await page.waitForTimeout(600);
              }
              console.log(`✅ Navigated to ${monthName} ${year}`);
              await page.waitForTimeout(1000);
              break;
            }
          } catch (error) {
            continue;
          }
        }
      }
      
      // Click on the target day
      console.log(`   Clicking on day ${day}...`);
      await page.waitForTimeout(1000); // Wait for calendar to be ready
      
      const daySelectors = [
        `button[aria-label*="Date ${day} ${monthNameShort}" i]`,
        `button[aria-label*="Date ${day} ${monthName}" i]`,
        `button[aria-label*="${day} ${monthNameShort}" i]`,
        `button[aria-label*="${day} ${monthName}" i]`,
        `button:has-text("${day}")`,
        `[aria-label*="${day}" i]`,
        `[data-date*="${DATE}"]`,
        `button[data-date*="${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}"]`
      ];
      
      let dayClicked = false;
      for (const selector of daySelectors) {
        try {
          const dayButton = await targetPage.locator(selector).first();
          if (await dayButton.isVisible({ timeout: 2000 })) {
            const ariaLabel = await dayButton.getAttribute('aria-label') || '';
            const text = await dayButton.textContent() || '';
            // Verify it's the right day
            if (ariaLabel.includes(day.toString()) || text.trim() === day.toString() || text.includes(`${day} ${monthNameShort}`)) {
              await dayButton.click();
              dayClicked = true;
              console.log(`✅ Selected date ${DATE} (${ariaLabel || text})`);
              await page.waitForTimeout(3000); // Wait for calendar to close and page to update
              break;
            }
          }
        } catch (error) {
          continue;
        }
      }
      
      if (!dayClicked) {
        console.log(`⚠️  Could not click day ${day}, trying alternative approach...`);
        // Try clicking any button with just the day number in calendar
        try {
          const allDayButtons = await targetPage.locator('button, [role="gridcell"], [role="button"]').all();
          console.log(`   Checking ${allDayButtons.length} potential day buttons...`);
          for (const btn of allDayButtons) {
            const text = await btn.textContent() || '';
            const ariaLabel = await btn.getAttribute('aria-label') || '';
            // Match day number and check for month context
            if ((text.trim() === day.toString() || ariaLabel.includes(`${day} ${monthNameShort}`) || ariaLabel.includes(`${day} ${monthName}`)) && 
                !ariaLabel.includes('next') && !ariaLabel.includes('previous') && !ariaLabel.includes('Next') && !ariaLabel.includes('Previous')) {
              console.log(`   Found day button: aria-label="${ariaLabel}", text="${text}"`);
              await btn.click();
              console.log(`✅ Clicked day ${day} via text/aria-label match`);
              await page.waitForTimeout(3000);
              dayClicked = true;
              break;
            }
          }
        } catch (error) {
          console.log(`⚠️  Could not select date automatically: ${error.message}`);
        }
      }
      
      // Check for "no availability" message after date selection
      if (dayClicked) {
        await page.waitForTimeout(2000);
        console.log('🔍 Checking for availability status...');
        const noAvailabilitySelectors = [
          ':has-text("no availability")',
          ':has-text("Unfortunately there is no availability")',
          ':has-text("no availability at the selected time")',
          '[class*="no-availability"]',
          '[class*="unavailable"]'
        ];
        
        let hasNoAvailability = false;
        for (const selector of noAvailabilitySelectors) {
          try {
            const element = await targetPage.locator(selector).first();
            if (await element.isVisible({ timeout: 2000 })) {
              const text = await element.textContent();
              if (text && !text.toLowerCase().includes('other dates')) {
                hasNoAvailability = true;
                console.log('❌ No availability message found for selected date');
                break;
              }
            }
          } catch (error) {
            continue;
          }
        }
        
        if (hasNoAvailability) {
          console.log('⚠️  Skipping time extraction - no availability for selected date');
          // Still monitor network but mark that we expect no times
        } else {
          console.log('✅ Availability check passed');
        }
      }
    }
    
    // Wait for SevenRooms iframe to load (if present)
    console.log('⏳ Waiting for SevenRooms iframe to load...');
    
    let iframe = null;
    try {
      const iframeElement = await page.waitForSelector('iframe[src*="sevenrooms"], iframe[src*="widget"], iframe[src*="booking"]', {
        timeout: 10000
      });
      if (iframeElement) {
        iframe = await iframeElement.contentFrame();
        console.log('✅ Found SevenRooms iframe');
        
        // Monitor iframe network traffic
        iframe.on('response', async (response) => {
          const url = response.url();
          const urlLower = url.toLowerCase();
          
          // Check if URL matches our patterns
          const urlPatterns = ['sevenrooms', 'availability', 'reservation', 'search', 'slot', 'booking', 'inventory'];
          const matchesPattern = urlPatterns.some(pattern => urlLower.includes(pattern));
          
          if (matchesPattern && relevantUrls.length < 50) {
            relevantUrls.push(url);
            console.log(`📡 [${relevantUrls.length}/50] ${url}`);
            
            // Try to parse as JSON
            try {
              const contentType = response.headers()['content-type'] || '';
              if (contentType.includes('json') || urlLower.includes('.json')) {
                const json = await response.json().catch(() => null);
                if (json) {
                  jsonResponses.push({ url, data: json });
                  // Only extract times if this response is for the selected date
                  if (hasTimesForDate(json, DATE)) {
                    const times = extractTimes(json);
                    times.forEach(time => allExtractedTimes.add(time));
                  }
                }
              }
            } catch (error) {
              // Not JSON or parsing failed, ignore
            }
          }
        });
      }
    } catch (error) {
      console.log('⚠️  SevenRooms iframe not found, monitoring main page traffic only...');
    }
    
    // Monitor for up to 20 seconds
    console.log('\n🔍 Monitoring network traffic for up to 20 seconds...');
    const startTime = Date.now();
    const monitorDuration = 20000; // 20 seconds
    
    while (Date.now() - startTime < monitorDuration && relevantUrls.length < 50) {
      await page.waitForTimeout(1000);
    }
    
    console.log(`\n📊 Network monitoring complete:`);
    console.log(`   Total relevant URLs found: ${relevantUrls.length}`);
    console.log(`   JSON responses collected: ${jsonResponses.length}`);
    
    // Extract all times
    const extractedTimesArray = Array.from(allExtractedTimes).sort();
    console.log(`\n⏰ Extracted times: ${extractedTimesArray.length > 0 ? extractedTimesArray.join(', ') : 'none'}`);
    
    // Filter times in window
    const timesInWindow = extractedTimesArray.filter(time => {
      return isTimeInWindow(time, WINDOW_START, WINDOW_END);
    });
    
    console.log(`\n🎯 Times in window (${WINDOW_START} - ${WINDOW_END}): ${timesInWindow.length > 0 ? timesInWindow.join(', ') : 'none'}`);
    
    // Verify we have responses for the selected date
    const responsesForDate = jsonResponses.filter(r => hasTimesForDate(r.data, DATE));
    console.log(`📅 JSON responses for selected date (${DATE}): ${responsesForDate.length}`);
    
    // Process times in window and send notifications
    // Only send notifications if we have date-specific responses
    if (timesInWindow.length > 0 && responsesForDate.length > 0) {
      for (const time of timesInWindow) {
        const timeKey = `${DATE}_${time}`;
        
        // Check if we've already notified for this time
        if (!state.notifiedTimes.includes(timeKey)) {
          console.log(`\n🔔 ${time} is in window and not yet notified! Sending notification...`);
          const sent = await sendNotification(time);
          
          if (sent) {
            state.notifiedTimes.push(timeKey);
            saveState(state);
            console.log(`✅ Notification sent for ${time}`);
          }
        } else {
          console.log(`ℹ️  Already notified for ${time}, skipping`);
        }
      }
    } else {
      console.log('\n❌ No times found in the specified window');
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
// Filters to only include times for the selected date
function extractTimesFromJson(json, selectedDate, times = [], parentDateMatches = false) {
  if (typeof json !== 'object' || json === null) return times;
  
  // Parse selected date for comparison
  const [year, month, day] = selectedDate.split('-').map(Number);
  const dateStr = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  const dateStrAlt = `${month}/${day}/${year}`;
  const dateStrAlt2 = `${day}/${month}/${year}`;
  
  // Check common field names
  const timeFields = ['time', 'startTime', 'start_time', 'slot', 'availability', 'reservationTime'];
  const dateFields = ['date', 'bookingDate', 'reservationDate', 'day', 'selectedDate'];
  
  // Check if this object has a date field that matches
  let dateMatches = parentDateMatches;
  for (const [key, value] of Object.entries(json)) {
    const lowerKey = key.toLowerCase();
    if (dateFields.some(field => lowerKey.includes(field))) {
      const valueStr = String(value);
      if (valueStr.includes(dateStr) || valueStr.includes(dateStrAlt) || valueStr.includes(dateStrAlt2)) {
        dateMatches = true;
        break;
      }
    }
  }
  
  for (const [key, value] of Object.entries(json)) {
    const lowerKey = key.toLowerCase();
    
    // If this looks like a time field
    if (timeFields.some(field => lowerKey.includes(field))) {
      if (typeof value === 'string' && value.match(/\d{1,2}:\d{2}/)) {
        // Only add if date matches (be conservative - don't add if unsure)
        if (dateMatches) {
          times.push(value);
        }
      }
    }
    
    // If this is an array, check each item
    if (Array.isArray(value)) {
      value.forEach(item => {
        if (typeof item === 'object') {
          extractTimesFromJson(item, selectedDate, times, dateMatches);
        } else if (typeof item === 'string' && item.match(/\d{1,2}:\d{2}/)) {
          // For array items, only add if date matches
          if (dateMatches) {
            times.push(item);
          }
        }
      });
    }
    
    // Recursively check nested objects
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      extractTimesFromJson(value, selectedDate, times, dateMatches);
    }
  }
  
  return times;
}

// Check if there's a "no availability" message for the selected date
async function checkNoAvailability(page) {
  try {
    const noAvailabilitySelectors = [
      ':has-text("no availability")',
      ':has-text("Unfortunately there is no availability")',
      ':has-text("no availability at the selected time")',
      '[class*="no-availability"]',
      '[class*="unavailable"]'
    ];
    
    for (const selector of noAvailabilitySelectors) {
      try {
        const element = await page.locator(selector).first();
        if (await element.isVisible({ timeout: 1000 })) {
          const text = await element.textContent();
          // Make sure it's about the selected date, not other dates
          if (text && !text.toLowerCase().includes('other dates')) {
            return true;
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

// Extract times from DOM as fallback - only for selected date
async function extractTimesFromDOM(page, selectedDate) {
  const times = [];
  
  try {
    // Parse selected date to match against
    const [year, month, day] = selectedDate.split('-').map(Number);
    const dateStr = `${day} ${getMonthName(month)}`;
    const dateStrAlt = `${month}/${day}`;
    
    // First, try to find the section that shows times for the selected date
    // Look for time slots that are NOT in "Other dates" sections
    const pageText = await page.textContent('body');
    
    // Check if there's an "Other dates" section - if so, exclude times from there
    const otherDatesMatch = pageText.match(/other dates with availability/i);
    const otherDatesIndex = otherDatesMatch ? pageText.indexOf(otherDatesMatch[0]) : -1;
    
    // Look for common time selectors
    const selectors = [
      '[data-time]',
      '[class*="time-slot"]',
      '[class*="available-time"]',
      'button[aria-label*="time"]',
      '[class*="slot"]:not([class*="other"])',
      '[class*="availability"]:not([class*="other"])'
    ];
    
    for (const selector of selectors) {
      try {
        const elements = await page.locator(selector).all();
        for (const element of elements) {
          // Get the element's position and context
          const elementText = await element.textContent();
          const elementIndex = pageText.indexOf(elementText || '');
          
          // Skip if this element is in the "Other dates" section
          if (otherDatesIndex !== -1 && elementIndex > otherDatesIndex) {
            continue;
          }
          
          // Check if this time slot is associated with the selected date
          // Look at parent elements for date context
          const parentContext = await element.evaluate(el => {
            let parent = el.parentElement;
            let context = '';
            let attempts = 0;
            while (parent && attempts < 5) {
              context = parent.textContent || '';
              if (context.includes('Feb') || context.includes('date') || context.includes('Feb')) {
                return context;
              }
              parent = parent.parentElement;
              attempts++;
            }
            return '';
          });
          
          // If parent context mentions "other dates", skip
          if (parentContext.toLowerCase().includes('other dates')) {
            continue;
          }
          
          // Extract time if it matches the pattern
          if (elementText && elementText.match(/\d{1,2}:\d{2}/)) {
            const timeMatch = elementText.match(/(\d{1,2}:\d{2})/);
            if (timeMatch) {
              times.push(timeMatch[1]);
            }
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    // Also check network responses for date-specific availability
    // This will be handled by the network interception above
    
  } catch (error) {
    console.log(`   ⚠️  DOM extraction error: ${error.message}`);
  }
  
  return times;
}

// Helper function to get month name
function getMonthName(monthNum) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[monthNum - 1] || '';
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
