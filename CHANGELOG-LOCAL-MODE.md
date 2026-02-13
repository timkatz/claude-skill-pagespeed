# Local Mode Update — 2026-02-13

## Summary

Updated local mode to remove INP (which cannot be measured with synthetic events) and add three lab-only metrics: TBT, SI, and TTI.

## Changes

### 1. Removed INP from Local Mode

**Why:** INP requires `PerformanceEventTiming` entries from real user interactions. Puppeteer's synthetic events (click, keyboard, pointer) do not generate these browser API entries. This is a fundamental browser limitation, not a bug.

Even Google Lighthouse doesn't measure INP in lab tests — it uses TBT as a proxy instead.

**What was removed:**
- All interaction simulation code (~100 lines of clicking buttons, keyboard presses, etc.)
- `onINP` registration in web-vitals
- INP from output display
- INP-related documentation suggesting it could work

**Impact:**
- Faster test execution (no time wasted on interactions that don't generate PerformanceEventTiming)
- Cleaner code (removed dead code)
- Accurate expectations (users now know INP requires API mode)

### 2. Added Lab-Only Metrics

#### Total Blocking Time (TBT)
- **What:** Time the main thread was blocked by long tasks (>50ms) between FCP and TTI
- **How:** Sum blocking time from PerformanceObserver long tasks
- **Thresholds:** ≤200ms 🟢, 200-600ms 🟡, >600ms 🔴

#### Speed Index (SI)
- **What:** How quickly page contents are visually populated
- **How:** FCP-based estimation (`fcp * 1.8` fallback, or interpolated with LCP if available)
- **Thresholds:** ≤3400ms 🟢, 3400-5800ms 🟡, >5800ms 🔴

#### Time to Interactive (TTI)
- **What:** When the page becomes fully interactive (main thread has 5-second quiet window)
- **How:** Calculate from long tasks — find first 5-second gap with no tasks >50ms after FCP
- **Thresholds:** ≤3800ms 🟢, 3800-7300ms 🟡, >7300ms 🔴

### 3. Updated Output Format

**Old:**
```
📱 Mobile (Local (Puppeteer)):
  LCP: 4.3s 🔴 | CLS: 0.31 🔴 | INP: N/A —
  FCP: 1.6s 🟢 | TTFB: 0.1s 🟢
```

**New:**
```
📱 Mobile (Local (Puppeteer)):
  CWV: LCP: 4.3s 🔴 | CLS: 0.31 🔴 | FCP: 1.6s 🟢 | TTFB: 0.1s 🟢
  Lab: TBT: 450ms 🟡 | SI: 2880ms 🟢 | TTI: 5.2s 🟡
```

**Benefits:**
- Clear separation between field-comparable CWV metrics and lab-only metrics
- More useful data for diagnosing performance issues
- No misleading "N/A" for INP

### 4. Updated Documentation

**README.md:**
- Added dedicated section explaining why INP is not available in local mode
- Documented all three lab metrics with thresholds
- Updated example output

**SKILL.md:**
- Added metric tables showing which metrics are available in API vs local mode
- Explained INP limitation
- Updated local mode section with new output format

## Testing

```bash
# Desktop only
node scripts/pagespeed-local.js agjeans.com

# Desktop + Mobile
node scripts/pagespeed-local.js --mobile agjeans.com
```

**Desktop results:**
```
🖥️ Desktop (Local (Puppeteer)):
  CWV: LCP: 0.5s 🟢 | CLS: 0.06 🟢 | FCP: 0.5s 🟢 | TTFB: 0.0s 🟢
  Lab: TBT: 0ms 🟢 | SI: 498ms 🟢 | TTI: 1.2s 🟢
```

**Mobile results:**
```
📱 Mobile (Local (Puppeteer)):
  CWV: LCP: 1.2s 🟢 | CLS: 0.00 🟢 | FCP: 0.8s 🟢 | TTFB: N/A —
  Lab: TBT: 0ms 🟢 | SI: 1067ms 🟢 | TTI: 0.8s 🟢
```

## Migration Guide

**If you were relying on INP in local mode:**
- Use API mode instead: `python3 pagespeed-single.py example.com`
- API mode uses CrUX field data (real user metrics) which includes INP
- For sites without CrUX data, INP will still be N/A (requires 28 days of Chrome user data)

**If you want INP for sites behind auth/firewall:**
- Implement web-vitals library on your live site
- Use Real User Monitoring (RUM) to capture field data
- Local synthetic testing fundamentally cannot measure INP

## Files Modified

1. `scripts/pagespeed-local.js` — Main implementation
2. `scripts/pagespeed-single.py` — Python wrapper (display logic)
3. `README.md` — User-facing documentation
4. `SKILL.md` — AI agent instruction set
5. `CHANGELOG-LOCAL-MODE.md` — This file
