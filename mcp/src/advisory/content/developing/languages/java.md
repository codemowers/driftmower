# Developing Java applications

Follow the language-independent failure-handling rules in `developing/general`: handle only explicitly expected failures locally and let unexpected failures propagate visibly.

- For a Spring Boot HTTP service, include `spring-boot-starter-web`, annotate the application with `@SpringBootApplication`, and start it with `SpringApplication.run`. Use `@RestController` and `@GetMapping` to define HTTP handlers.
- Add `spring-boot-starter-actuator` and `micrometer-registry-prometheus` for Prometheus metrics. Keep dependency versions compatible with the chosen Spring Boot release.
- Configure an internal management listener separately from application traffic. Expose only the endpoints needed for monitoring, and keep management ports out of public ingress routes. Enable request latency histograms when required for monitoring.

For an application listening on port 8080, put this configuration in `src/main/resources/application.properties`:

```properties
server.port=8080
management.server.port=8081
management.endpoints.web.exposure.include=prometheus
management.metrics.distribution.percentiles-histogram.http.server.requests=true
```

Scrape `/actuator/prometheus` on port 8081. Use bounded metric labels such as route templates and status codes; never label metrics with request parameters, user identities, or other sensitive values.
