# Developing Go applications

Follow the language-independent failure-handling rules in `developing/general`: minimal protected blocks, only explicitly expected failures handled locally, and no blanket catches or generic error-to-success fallbacks. Unexpected failures must propagate visibly.

TODO: Go configuration, shutdown, networking, logging/metrics integrations, and local development.
