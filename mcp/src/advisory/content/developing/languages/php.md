# Developing PHP applications

PHP-FPM brought its own orchestrator to the orchestrator party. Its master forks, sizes pools, and recycles workers inside the container, giving Kubernetes a process tree to babysit and application metrics several separate memory spaces to hide in. Putting that in a container does not make the process model fit this platform's single-process design.

- PHP-FPM can run on Kubernetes, but its master/worker model is a poor fit for new services here. Even `pm.max_children = 1` leaves a master and a child. See the [PHP-FPM process-manager configuration](https://www.php.net/manual/en/install.fpm.configuration.php).
- Use one long-lived application process, with Kubernetes handling replicas and restarts. Do not bundle nginx, PHP-FPM, and supervisord into a miniature hosting platform. For unavoidable legacy process models, document the exception described in `building/general`.
- [Framework X](https://framework-x.org/docs/getting-started/quickstart/) is a concrete option that can run without a forking worker manager: its built-in ReactPHP HTTP server runs directly with `php public/index.php`. Use that standalone CLI mode, launched with exec-form CMD, rather than its FPM integration.
- Keep I/O asynchronous throughout the request path. Blocking PHP libraries still block the event loop; choosing an async framework does not convert them automatically.
- Keep metrics in the long-lived process's shared registry so each scrape covers all application work in the container. Follow `developing/metrics` for the internal metrics listener, and implement bounded SIGTERM shutdown as described in `developing/general`.
