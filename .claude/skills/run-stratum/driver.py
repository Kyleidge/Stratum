"""Drive the Stratum web app in a fresh headless Chrome.

Reads one command per line from stdin (or --script FILE), starting the vinext
dev server first if nothing answers at --url. Every run uses a new browser
profile, so the workspace (IndexedDB) starts empty. Paths are relative to the
repository root; screenshots default to outputs/run-stratum/.

    python .claude/skills/run-stratum/driver.py <<'EOF'
    example
    shot batch.png
    EOF

Commands ("=>" separates a selector from its argument; selectors are
Playwright selectors such as `role=button[name="Import CSV"]`, `text=Fail`
or CSS):

    click SEL                 real mouse click
    dblclick SEL
    fill SEL => TEXT          replace an input's text (\\n for new lines)
    type TEXT                 type at the focused element
    press KEY                 e.g. F2, Enter, Alt+ArrowRight, Control+Z
    select SEL => LABEL       choose a native <select> option by label
    check SEL / uncheck SEL   set a Base UI checkbox (role=checkbox)
    upload SEL => FILE[|FILE] click SEL and answer the file chooser; globs ok
    download SEL => PATH      click SEL and save the triggered download
    wait SEL                  wait until visible (default 30 s)
    gone SEL                  wait until hidden
    sleep SECONDS
    shot NAME.png             screenshot (outputs/run-stratum/ unless a path)
    text SEL                  print the first match's visible text
    count SEL                 print how many elements match
    eval JS                   evaluate an expression, print JSON
    goto PATH                 navigate relative to --url
    example                   Import ▾ → batch example → run 8 motors
                              (downloads unticked) and wait for completion
"""
import argparse
import asyncio
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
OUT = os.path.join(ROOT, "outputs", "run-stratum")


def find_node():
    node = shutil.which("node")
    if node:
        return node
    # Python Playwright ships a Node runtime; use it when Node is not on PATH.
    import playwright

    folder = os.path.join(os.path.dirname(playwright.__file__), "driver")
    for name in ("node.exe", "node"):
        candidate = os.path.join(folder, name)
        if os.path.exists(candidate):
            return candidate
    sys.exit("No Node.js found on PATH or in Python Playwright's driver folder.")


def answering(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            return response.status == 200
    except Exception:
        return False


def start_server(url):
    if not os.path.exists(os.path.join(ROOT, "node_modules", "vinext")):
        sys.exit(
            "node_modules is missing. Run `pnpm install --frozen-lockfile`, or "
            "link a sibling checkout's node_modules (see SKILL.md)."
        )
    port = url.rstrip("/").rsplit(":", 1)[-1]
    os.makedirs(OUT, exist_ok=True)
    log = open(os.path.join(OUT, "dev-server.log"), "w", encoding="utf-8")
    server = subprocess.Popen(
        [find_node(), "node_modules/vinext/dist/cli.js", "dev", "--port", port],
        cwd=ROOT,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    deadline = time.time() + 120
    while time.time() < deadline:
        if server.poll() is not None:
            log.close()
            text = open(log.name, encoding="utf-8", errors="replace").read()
            # vinext allows one dev server per checkout, on any port; reuse it.
            match = re.search(r"Local:\s+(http://\S+)", text)
            if "already running" in text and match and answering(match.group(1)):
                existing = match.group(1).rstrip("/") + "/"
                print(f"reusing the dev server already running at {existing}")
                return None, existing
            sys.exit(f"Dev server exited early; see {log.name}")
        if answering(url):
            print(f"dev server ready at {url} (log: {os.path.relpath(log.name, ROOT)})")
            return server, url
        time.sleep(0.5)
    server.terminate()
    sys.exit(f"Dev server did not answer within 120 s; see {log.name}")


def split(rest):
    if "=>" not in rest:
        raise ValueError("expected `SELECTOR => VALUE`")
    selector, value = rest.split("=>", 1)
    return selector.strip(), value.strip()


def resolve(path, default_dir=ROOT):
    return path if os.path.isabs(path) else os.path.join(default_dir, path)


async def example(page):
    """The end-of-line batch example, run from the Import menu."""
    await page.get_by_role("button", name="Workflow and batch options").click()
    await page.get_by_role("menuitem", name="Try the batch example (8 motors)").click()
    dialog = page.locator("[role=dialog][data-open]")
    await dialog.get_by_text("Run workflow on recordings").wait_for()
    for label in (
        "Download a summary CSV when the batch finishes",
        "Export a PDF report for each item",
    ):
        box = dialog.get_by_role("checkbox", name=label)
        if await box.get_attribute("aria-checked") == "true":
            await box.click()
    await dialog.get_by_role("button", name="Run 8 recordings").click()
    await page.locator(".workflow-batch-header", has_text="complete").wait_for(timeout=90000)
    rows = await page.eval_on_selector_all(
        ".workflow-batch-table tbody tr",
        "rows => rows.map(r => [...r.cells].slice(0, 3)"
        ".map(c => c.innerText.split(/\\s+/).join(' ').trim()))",
    )
    for row in rows:
        print("  " + " | ".join(row))


async def run_command(page, line, base):
    command, _, rest = line.partition(" ")
    rest = rest.strip()
    if command == "click":
        await page.locator(rest).first.click()
    elif command == "dblclick":
        await page.locator(rest).first.dblclick()
    elif command == "fill":
        selector, text = split(rest)
        await page.locator(selector).first.fill(text.replace("\\n", "\n"))
    elif command == "type":
        await page.keyboard.type(rest.replace("\\n", "\n"), delay=20)
    elif command == "press":
        await page.keyboard.press(rest)
    elif command == "select":
        selector, label = split(rest)
        await page.locator(selector).first.select_option(label=label)
    elif command in ("check", "uncheck"):
        box = page.locator(rest).first
        want = "true" if command == "check" else "false"
        if await box.get_attribute("aria-checked") != want:
            await box.click()
    elif command == "upload":
        selector, files = split(rest)
        paths = []
        for pattern in files.split("|"):
            matches = sorted(glob.glob(resolve(pattern.strip())))
            if not matches:
                raise FileNotFoundError(pattern.strip())
            paths.extend(matches)
        async with page.expect_file_chooser() as chooser:
            await page.locator(selector).first.click()
        await (await chooser.value).set_files(paths)
        print(f"  uploaded {len(paths)} file(s)")
    elif command == "download":
        selector, target = split(rest)
        async with page.expect_download(timeout=120000) as info:
            await page.locator(selector).first.click()
        download = await info.value
        destination = resolve(target, OUT)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        await download.save_as(destination)
        print(f"  saved {download.suggested_filename} -> {os.path.relpath(destination, ROOT)}")
    elif command == "wait":
        await page.locator(rest).first.wait_for(timeout=30000)
    elif command == "gone":
        await page.locator(rest).first.wait_for(state="hidden", timeout=30000)
    elif command == "sleep":
        await asyncio.sleep(float(rest))
    elif command == "shot":
        destination = resolve(rest, OUT)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        await page.screenshot(path=destination)
        print(f"  screenshot -> {os.path.relpath(destination, ROOT)}")
    elif command == "text":
        print("  " + (await page.locator(rest).first.inner_text()).strip()[:2000])
    elif command == "count":
        print(f"  {await page.locator(rest).count()}")
    elif command == "eval":
        print("  " + json.dumps(await page.evaluate(rest), ensure_ascii=False)[:4000])
    elif command == "goto":
        await page.goto(base.rstrip("/") + "/" + rest.lstrip("/"))
    elif command == "example":
        await example(page)
    else:
        raise ValueError(f"unknown command `{command}`")


async def main():
    # Windows consoles default to cp1252, which cannot print "≤" or "·".
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--url", default="http://localhost:3107/")
    parser.add_argument("--script", help="read commands from this file instead of stdin")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--channel", default="chrome", help="chrome, msedge, or '' for bundled Chromium")
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--height", type=int, default=900)
    parser.add_argument("--keep-server", action="store_true", help="leave a server this run started running")
    args = parser.parse_args()
    source = open(args.script, encoding="utf-8") if args.script else sys.stdin
    lines = [line.strip() for line in source.read().splitlines()]
    server, url = (None, args.url) if answering(args.url) else start_server(args.url)
    errors = []
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                channel=args.channel or None, headless=not args.headed
            )
            context = await browser.new_context(
                viewport={"width": args.width, "height": args.height}, accept_downloads=True
            )
            page = await context.new_page()
            page.set_default_timeout(30000)
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on(
                "console",
                lambda message: errors.append(message.text)
                if message.type == "error" and not message.text.startswith("Failed to load resource")
                else None,
            )
            page.on(
                "response",
                lambda response: errors.append(f"HTTP {response.status} {response.url}")
                if response.status >= 400
                else None,
            )
            await page.goto(url)
            # The worker opens IndexedDB after the shell renders.
            await page.wait_for_function(
                "() => document.querySelector('main') && !document.querySelector('main').textContent.includes('Opening your workflow')",
                timeout=60000,
            )
            print("app ready")
            for line in lines:
                if not line or line.startswith("#"):
                    continue
                print(f"> {line}")
                try:
                    await run_command(page, line, url)
                except Exception as error:
                    os.makedirs(OUT, exist_ok=True)
                    await page.screenshot(path=os.path.join(OUT, "error.png"))
                    print(f"  FAILED: {error}\n  screenshot -> outputs/run-stratum/error.png")
                    raise SystemExit(1)
            if errors:
                print("page errors:\n  " + "\n  ".join(errors[:20]))
            await browser.close()
    finally:
        if server and not args.keep_server:
            server.terminate()


if __name__ == "__main__":
    asyncio.run(main())
