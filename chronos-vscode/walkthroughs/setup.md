# Install dependencies

Chronos drives the [`pi`](https://github.com/badlogic/pi-mono) agent CLI and loads
the **Chronos pi-package** into it. Both install once per machine.

Running **Install dependencies** opens a terminal that runs:

```
npm install -g @earendil-works/pi-coding-agent
pi install https://github.com/ai-historian/chronos@v<version>
```

- Already have them? The command detects that and just confirms you're ready.
- The pi-package is pinned to this extension's version, so upgrading the
  extension re-installs the matching agent automatically.
- This step is safe to re-run anytime to **repair or upgrade** your install.

The checkmark appears once `pi` and the package are detected — a few seconds
after the terminal finishes.
