# Application logging

- Send logs to stdout or stderr; plain text and structured JSON are both acceptable. Choose the format appropriate to the application and its consumers. Do not report plain-text logging alone as a compliance gap. Let the container runtime collect, rotate, and retain logs.
- Do not maintain log files inside the container or add a timestamp already supplied by the runtime.
- Use standard severity levels where useful.
- Prefer a metric for information that can be measured efficiently instead of emitting repetitive log records.
