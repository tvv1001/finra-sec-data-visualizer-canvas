#!/usr/bin/env python3
"""Anti-bot page fetcher used as a fallback for blocked directory pages.

Outputs JSON to stdout:
{
  "ok": true|false,
  "url": "...",
  "html": "...",
  "peoplePayload": "...",
  "signals": { ... },
  "error": "..."
}
"""

from __future__ import annotations

import asyncio
import json
import random
import sys
from dataclasses import dataclass

try:
  from playwright.async_api import async_playwright
except Exception:  # pragma: no cover - optional runtime dependency
  async_playwright = None


@dataclass
class ScrapeConfig:
  url: str
  timeout_ms: int = 25000
  extra_wait_ms: int = 2500


def _safe_print(payload: dict) -> None:
  sys.stdout.write(json.dumps(payload, ensure_ascii=False))
  sys.stdout.flush()


async def _human_like_actions(page) -> None:
  # Steady, slow human-like behavior to reduce detection.
  for _ in range(random.randint(3, 6)):
    x = random.randint(100, 1200)
    y = random.randint(120, 760)
    await page.mouse.move(x, y, steps=random.randint(20, 40))
    await asyncio.sleep(random.uniform(0.5, 1.5))

  for _ in range(random.randint(3, 7)):
    await page.mouse.wheel(0, random.randint(200, 600))
    await asyncio.sleep(random.uniform(0.8, 2.2))

  await page.evaluate(
    """
    async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      let last = 0;
      let stable = 0;
      for (let i = 0; i < 24; i += 1) {
        const h = Math.max(
          document.body?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0
        );
        const y = window.scrollY || 0;
        const step = Math.max(Math.floor(window.innerHeight * 0.6), 250);
        window.scrollTo(0, Math.min(y + step, h));
        await wait(1200); // Slower scroll pause
        const h2 = Math.max(
          document.body?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0
        );
        if (h2 === last) {
          stable += 1;
        } else {
          stable = 0;
          last = h2;
        }
        if (stable >= 4) break;
      }
    }
    """
  )


async def _run(config: ScrapeConfig) -> dict:
  if async_playwright is None:
    return {
      "ok": False,
      "url": config.url,
      "html": "",
      "peoplePayload": "",
      "signals": {},
      "error": "python-playwright-not-installed",
    }

  # Initial jitter to stagger starts if called in batches
  await asyncio.sleep(random.uniform(2.0, 5.0))

  async with async_playwright() as pw:
    browser = await pw.chromium.launch(
      headless=True,
      args=["--no-sandbox", "--disable-setuid-sandbox"],
    )

    context = await browser.new_context(
      user_agent=(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
      ),
      locale="en-US",
      viewport={"width": 1440, "height": 900},
    )

    # Blocking heavy resources both improves speed and resembles ad-blocked traffic.
    async def _route(route):
      if route.request.resource_type in ("image", "media", "font"):
        await route.abort()
      else:
        await route.continue_()

    await context.route("**/*", _route)

    page = await context.new_page()

    try:
      response = await page.goto(
        config.url,
        wait_until="domcontentloaded",
        timeout=config.timeout_ms,
      )

      # Check for 429 or other error statuses
      if response and response.status == 429:
          await browser.close()
          return {
              "ok": False,
              "url": config.url,
              "error": "429-too-many-requests",
              "status": 429
          }

      await asyncio.sleep(random.uniform(1.5, 3.0))

      await page.wait_for_selector(
        "h2, h3, [data-amp-label='WPClickedPersonResults']",
        timeout=10000,
      )

      await page.wait_for_function(
        r"""
        () => {
          const html = document.documentElement?.outerHTML || "";
          return /(?:var|let|const)\\s+people\\s*=\\s*\[/.test(html)
            || Array.isArray(window.people)
            || /window\\.__NUXT__/i.test(html)
            || /type=["']application\\/ld\\+json["']/i.test(html);
        }
        """,
        timeout=12000,
      )
    except Exception as e:
      # Continue; page may still contain usable HTML or may be blocked.
      if "429" in str(e):
          await browser.close()
          return {"ok": False, "url": config.url, "error": "429-too-many-requests", "status": 429}

    try:
      await _human_like_actions(page)
    except Exception:
      pass

    await asyncio.sleep(max(3000, config.extra_wait_ms) / 1000)

    signals = await page.evaluate(
      r"""
      () => {
        const html = document.documentElement?.outerHTML || "";
        return {
          peopleVar: /(?:var|let|const)\s+people\s*=\s*\[/i.test(html),
          windowPeople: Array.isArray(window.people),
          nuxt: /window\.__NUXT__/i.test(html),
          jsonLd: /type=["']application\/ld\+json["']/i.test(html),
          title: document.title || "",
        };
      }
      """
    )

    people_payload = await page.evaluate(
      """
      () => {
        if (!Array.isArray(window.people)) return "";
        try {
          return JSON.stringify(window.people);
        } catch {
          return "";
        }
      }
      """
    )

    html = await page.content()

    await context.close()
    await browser.close()

    return {
      "ok": True,
      "url": config.url,
      "html": html,
      "peoplePayload": people_payload,
      "signals": signals,
    }


def _parse_args(argv: list[str]) -> ScrapeConfig:
  url = argv[1] if len(argv) > 1 else ""
  timeout_ms = int(argv[2]) if len(argv) > 2 else 25000
  extra_wait_ms = int(argv[3]) if len(argv) > 3 else 2500
  return ScrapeConfig(url=url, timeout_ms=timeout_ms, extra_wait_ms=extra_wait_ms)


async def _main() -> int:
  config = _parse_args(sys.argv)
  if not config.url:
    _safe_print({"ok": False, "error": "Missing URL argument"})
    return 2

  try:
    result = await _run(config)
    _safe_print(result)
    return 0
  except Exception as error:
    _safe_print({"ok": False, "url": config.url, "error": str(error)})
    return 1


if __name__ == "__main__":
  raise SystemExit(asyncio.run(_main()))
