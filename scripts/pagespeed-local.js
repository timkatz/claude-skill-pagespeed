#!/usr/bin/env node

/**
 * Local Core Web Vitals Measurement using Puppeteer + web-vitals
 * 
 * Measures CWV locally without calling Google API.
 * Follows the pattern from Hux's production-performance-capture.js.
 * 
 * Usage:
 *   node pagespeed-local.js example.com
 *   node pagespeed-local.js --mobile example.com
 *   node pagespeed-local.js --json example.com
 *   node pagespeed-local.js site-a.com site-b.com  # compare mode
 */

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

// Thresholds for rating (from pagespeed-single.py)
const THRESHOLDS = {
  lcp:  { good: 2.5, poor: 4.0 },
  cls:  { good: 0.1, poor: 0.25 },
  inp:  { good: 200, poor: 500 },
  fcp:  { good: 1.8, poor: 3.0 },
  ttfb: { good: 0.8, poor: 1.8 },
};

class LocalCWVMeasurement {
  constructor(options = {}) {
    this.debug = options.debug || false;
    this.webVitalsLib = null;
    this.mobile = options.mobile || false;
  }

  async init() {
    // Load web-vitals library
    const possiblePaths = [
      path.join(__dirname, '../node_modules/web-vitals/dist/web-vitals.iife.js'),
      path.join(process.cwd(), 'node_modules/web-vitals/dist/web-vitals.iife.js'),
    ];
    
    for (const webVitalsPath of possiblePaths) {
      try {
        this.webVitalsLib = await fs.readFile(webVitalsPath, 'utf-8');
        if (this.debug) console.error(`✅ Web-vitals library loaded from: ${webVitalsPath}`);
        return;
      } catch (error) {
        // Try next path
      }
    }
    
    throw new Error('❌ Web-vitals library not found. Run: npm install web-vitals');
  }

  log(message) {
    if (this.debug) {
      const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
      console.error(`[${timestamp}] ${message}`);
    }
  }

  async measure(url) {
    if (!url.startsWith('http')) {
      url = `https://${url}`;
    }

    this.log(`🌐 Measuring ${url} (${this.mobile ? 'mobile' : 'desktop'})...`);

    const browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--enable-blink-features=LayoutInstabilityAPI,LargestContentfulPaint',
        '--enable-features=ElementTiming',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
      ]
    });

    try {
      const page = await browser.newPage();
      
      // Configure viewport and user agent
      if (this.mobile) {
        await page.setViewport({ 
          width: 412, 
          height: 823, 
          deviceScaleFactor: 2.625,
          isMobile: true,
          hasTouch: true
        });
        await page.setUserAgent('Mozilla/5.0 (Linux; Android 10; Pixel 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36');
      } else {
        await page.setViewport({ width: 1350, height: 940 });
      }

      // Inject web-vitals before navigation
      if (this.webVitalsLib) {
        await page.evaluateOnNewDocument(this.webVitalsLib);
        this.log('✅ Web-vitals library injected');
      }

      // Set up metric collection
      await page.evaluateOnNewDocument(() => {
        window.__performanceMetrics = {
          webVitals: {},
          longTasks: [],
          lcpCandidates: []
        };

        // Track long tasks for TBT
        if (typeof PerformanceObserver !== 'undefined') {
          const taskObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.duration > 50) {
                window.__performanceMetrics.longTasks.push({
                  startTime: entry.startTime,
                  duration: entry.duration,
                  blockingTime: entry.duration - 50
                });
              }
            }
          });
          
          try {
            taskObserver.observe({ entryTypes: ['longtask'] });
          } catch (e) {
            // Long tasks not supported
          }
        }

        // Initialize web-vitals collection
        if (typeof webVitals !== 'undefined') {
          const captureMetric = (metric) => {
            window.__performanceMetrics.webVitals[metric.name] = {
              value: metric.value,
              rating: metric.rating,
              delta: metric.delta
            };
          };

          webVitals.onLCP(captureMetric, { reportAllChanges: true });
          webVitals.onFCP(captureMetric);
          webVitals.onCLS(captureMetric, { reportAllChanges: true });
          webVitals.onTTFB(captureMetric);
          webVitals.onFID(captureMetric);
          webVitals.onINP(captureMetric, { reportAllChanges: true });
        }

        // Track LCP candidates
        if (typeof PerformanceObserver !== 'undefined') {
          const lcpObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              window.__performanceMetrics.lcpCandidates.push({
                startTime: entry.startTime,
                renderTime: entry.renderTime || entry.startTime,
                size: entry.size
              });
            }
          });
          
          try {
            lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
          } catch (e) {}
        }
      });

      // Enable throttling for mobile
      if (this.mobile) {
        const client = await page.target().createCDPSession();
        await client.send('Network.enable');
        await client.send('Network.emulateNetworkConditions', {
          offline: false,
          downloadThroughput: 1.5 * 1024 * 1024 / 8, // 1.5 Mbps
          uploadThroughput: 750 * 1024 / 8, // 750 Kbps
          latency: 40 // 40ms
        });
        await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        this.log('📱 Mobile throttling enabled (3G network, 4x CPU slowdown)');
      }

      // Navigate to URL
      this.log(`🌐 Navigating to ${url}...`);
      await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      this.log('✅ Page loaded (DOMContentLoaded)');

      // Wait for initial stabilization
      this.log('⏳ Waiting 5s for initial page stabilization...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Progressive checks with scrolling (trigger lazy loading)
      const maxWaitTime = 15000;
      const checkInterval = 3000;
      let lastLCP = null;
      let stableLCPCount = 0;

      this.log('🔄 Starting progressive metric collection...');
      for (let elapsed = 0; elapsed < maxWaitTime; elapsed += checkInterval) {
        // Check current LCP
        const currentLCP = await page.evaluate(() => {
          const perf = window.__performanceMetrics || {};
          return perf.webVitals?.LCP?.value || null;
        });

        if (currentLCP === lastLCP && currentLCP !== null) {
          stableLCPCount++;
          if (stableLCPCount >= 2) {
            this.log(`✅ LCP stabilized at ${currentLCP.toFixed(0)}ms`);
            break;
          }
        } else {
          stableLCPCount = 0;
          lastLCP = currentLCP;
        }

        // Scroll to trigger lazy loading
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }

      // Scroll back to top
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise(resolve => setTimeout(resolve, 500));

      // Force LCP finalization by clicking body
      this.log('🖱️ Forcing LCP finalization...');
      try {
        await page.click('body');
      } catch (e) {
        // Click may fail, that's ok
      }
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Simulate user interactions for INP
      this.log('🖱️ Simulating interactions for INP...');
      try {
        // Find clickable elements
        const clickable = await page.evaluate(() => {
          const elements = [];
          const selectors = ['button:not([disabled])', '[role="button"]', '.btn', '.button'];
          
          selectors.forEach(selector => {
            const els = document.querySelectorAll(selector);
            els.forEach(el => {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0 && 
                  rect.top >= 0 && rect.top < window.innerHeight) {
                elements.push({
                  x: rect.left + rect.width / 2,
                  y: rect.top + rect.height / 2
                });
              }
            });
          });
          
          return elements.slice(0, 2); // Max 2 clicks
        });

        for (const el of clickable) {
          await page.mouse.click(el.x, el.y);
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Fallback: keyboard interaction
        if (clickable.length === 0) {
          await page.keyboard.press('Tab');
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      } catch (e) {
        this.log(`⚠️ Interaction failed: ${e.message}`);
      }

      // Wait for INP to finalize
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Collect all metrics
      this.log('📊 Collecting final metrics...');
      const metrics = await page.evaluate(() => {
        const perf = window.__performanceMetrics || {};
        const nav = performance.getEntriesByType('navigation')[0];
        const paint = performance.getEntriesByType('paint');
        const lcpEntries = performance.getEntriesByType('largest-contentful-paint');

        // Calculate TBT
        let totalBlockingTime = 0;
        if (perf.longTasks && perf.longTasks.length > 0) {
          const fcp = paint.find(e => e.name === 'first-contentful-paint')?.startTime || 0;
          const tti = nav ? nav.loadEventEnd : 5000;
          
          perf.longTasks.forEach(task => {
            if (task.startTime >= fcp && task.startTime < tti) {
              totalBlockingTime += task.blockingTime;
            }
          });
        }

        // Get final LCP
        let finalLCP = perf.webVitals?.LCP?.value || null;
        if (lcpEntries.length > 0) {
          const apiLCP = lcpEntries[lcpEntries.length - 1].startTime;
          if (!finalLCP || apiLCP > finalLCP) {
            finalLCP = apiLCP;
          }
        }

        // Calculate TTI (LCP + TBT as proxy)
        const tti = finalLCP && totalBlockingTime !== null ? 
          finalLCP + totalBlockingTime : null;

        // Calculate Speed Index (simple approximation)
        const fcp = perf.webVitals?.FCP?.value || 
          paint.find(e => e.name === 'first-contentful-paint')?.startTime || null;
        const speedIndex = fcp ? fcp * 1.8 : null;

        return {
          lcp: finalLCP ? Math.round(finalLCP) / 1000 : null,
          fcp: fcp ? Math.round(fcp) / 1000 : null,
          cls: perf.webVitals?.CLS?.value || 0,
          ttfb: perf.webVitals?.TTFB?.value ? Math.round(perf.webVitals.TTFB.value) / 1000 : null,
          inp: perf.webVitals?.INP?.value || null,
          tbt: Math.round(totalBlockingTime),
          tti: tti ? Math.round(tti) / 1000 : null,
          speedIndex: speedIndex ? Math.round(speedIndex) / 1000 : null,
          source: 'Local (Puppeteer)'
        };
      });

      this.log('✅ Metrics collected');
      await browser.close();

      return metrics;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }
}

// Formatting functions (matching pagespeed-single.py)
function indicator(metric, value) {
  if (value === null || value === undefined) return '—';
  const { good, poor } = THRESHOLDS[metric] || { good: 0, poor: 999 };
  if (value <= good) return '🟢';
  if (value <= poor) return '🟡';
  return '🔴';
}

function fmt(metric, value) {
  if (value === null || value === undefined) return 'N/A';
  if (metric === 'inp') return `${Math.round(value)}ms`;
  if (metric === 'cls') return value.toFixed(2);
  return `${value.toFixed(1)}s`;
}

function printSingle(url, mobile, desktop) {
  console.log(`\n🌐 **${url}** — CWV: Local Measurement\n`);
  
  for (const [label, data] of [['📱 Mobile', mobile], ['🖥️ Desktop', desktop]]) {
    if (data) {
      const metrics = ['lcp', 'cls', 'inp', 'fcp', 'ttfb'].map(k => {
        const v = data[k];
        return `${k.upper()}: ${fmt(k, v)} ${indicator(k, v)}`;
      });
      console.log(`${label} *(${data.source})*:`);
      console.log(`  ${metrics.slice(0, 3).join(' | ')}`);
      console.log(`  ${metrics.slice(3).join(' | ')}`);
    } else {
      console.log(`${label}: ❌ Measurement failed`);
    }
  }
  console.log(`\n📊 Data Source: ${mobile?.source || desktop?.source || 'N/A'}`);
}

function printCompare(urlA, mobA, deskA, urlB, mobB, deskB) {
  console.log(`\n⚔️ **CWV Comparison: ${urlA} vs ${urlB}** *(Local)*\n`);
  console.log(`| Metric | ${urlA} | ${urlB} | Winner |`);
  console.log(`|--------|${'---'.repeat(5)}|${'---'.repeat(5)}|--------|`);
  
  const wins = { [urlA]: 0, [urlB]: 0 };
  
  for (const [prefix, dataA, dataB] of [['📱', mobA, mobB], ['🖥️', deskA, deskB]]) {
    if (!dataA || !dataB) continue;
    
    for (const k of ['lcp', 'cls', 'inp', 'fcp', 'ttfb']) {
      const va = dataA[k];
      const vb = dataB[k];
      const fa = va !== null ? `${fmt(k, va)} ${indicator(k, va)}` : 'N/A';
      const fb = vb !== null ? `${fmt(k, vb)} ${indicator(k, vb)}` : 'N/A';
      
      let winner = '—';
      if (va !== null && vb !== null) {
        if (va < vb) {
          winner = `✅ ${urlA}`;
          wins[urlA]++;
        } else if (vb < va) {
          winner = `✅ ${urlB}`;
          wins[urlB]++;
        } else {
          winner = 'Tie';
        }
      }
      
      const label = `${prefix} ${k.toUpperCase()}`;
      console.log(`| ${label} | ${fa} | ${fb} | ${winner} |`);
    }
  }
  
  const total = wins[urlA] + wins[urlB];
  const leader = wins[urlA] >= wins[urlB] ? urlA : urlB;
  console.log(`\n**Overall: ${leader} wins ${wins[leader]}/${total} metrics**`);
}

async function main() {
  const args = process.argv.slice(2);
  
  // Parse flags
  let mobile = false;
  let jsonOutput = false;
  let debug = false;
  const urls = [];
  
  for (const arg of args) {
    if (arg === '--mobile') mobile = true;
    else if (arg === '--json') jsonOutput = true;
    else if (arg === '--debug') debug = true;
    else if (!arg.startsWith('--')) urls.push(arg);
  }
  
  if (urls.length === 0) {
    console.error('Usage: node pagespeed-local.js [--mobile] [--json] [--debug] <url> [<url2> ...]');
    process.exit(1);
  }

  const results = [];
  
  for (const url of urls) {
    const measurer = new LocalCWVMeasurement({ mobile: false, debug });
    await measurer.init();
    
    console.error(`Measuring ${url} (desktop)...`);
    let desktop = null;
    try {
      desktop = await measurer.measure(url);
    } catch (error) {
      console.error(`❌ Desktop measurement failed: ${error.message}`);
    }
    
    let mobileData = null;
    if (mobile) {
      console.error(`Measuring ${url} (mobile)...`);
      const mobileMeasurer = new LocalCWVMeasurement({ mobile: true, debug });
      await mobileMeasurer.init();
      try {
        mobileData = await mobileMeasurer.measure(url);
      } catch (error) {
        console.error(`❌ Mobile measurement failed: ${error.message}`);
      }
    }
    
    results.push({ url, mobile: mobileData, desktop });
  }
  
  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  }
  
  if (results.length === 1) {
    const { url, mobile, desktop } = results[0];
    printSingle(url, mobile, desktop);
  } else if (results.length === 2) {
    printCompare(
      results[0].url, results[0].mobile, results[0].desktop,
      results[1].url, results[1].mobile, results[1].desktop
    );
  } else {
    console.log('\n📊 **Batch CWV Results** *(Local)*\n');
    console.log('| Site | LCP | CLS | INP | FCP | TTFB |');
    console.log('|------|-----|-----|-----|-----|------|');
    for (const { url, desktop } of results) {
      if (desktop) {
        const metrics = ['lcp', 'cls', 'inp', 'fcp', 'ttfb'].map(k => {
          const v = desktop[k];
          return v !== null ? `${fmt(k, v)} ${indicator(k, v)}` : 'N/A';
        });
        console.log(`| ${url} | ${metrics.join(' | ')} |`);
      } else {
        console.log(`| ${url} | ERROR | — | — | — | — |`);
      }
    }
  }
}

// String.prototype.upper() helper for formatting
String.prototype.upper = function() { return this.toUpperCase(); };

main().catch(error => {
  console.error(`\n❌ Error: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
