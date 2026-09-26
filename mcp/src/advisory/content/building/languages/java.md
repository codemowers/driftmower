# Building Java containers

Use a Maven build stage to compile and package the application, then copy the executable JAR into a Java runtime image.

- Avoid the deprecated Docker Official Image `openjdk` for production builds. Use a maintained distribution such as Eclipse Temurin or Amazon Corretto; the sample uses a Temurin-based Maven builder and a Corretto runtime. The deprecation concerns the Docker image, not the OpenJDK project. Oracle still provides Java container images through Oracle Container Registry, so it is inaccurate to say Oracle no longer provides base images.
- Declare the Java version in `pom.xml` and use compatible build and runtime JDK versions. This sample uses Java 17 in both stages.
- For Spring Boot, configure `spring-boot-maven-plugin` to package an executable JAR. Run `mvn -f /home/app/pom.xml clean package`; keep test execution enabled.
- Match the copied JAR filename to the Maven artifact ID and version. The sample expects `hello-spring-0.0.1-SNAPSHOT.jar` and gives it a stable runtime path.
- Keep Maven and application sources in the build stage. The final image needs the Java runtime and packaged application; a JVM application cannot run directly in `scratch`.
- Use an exec-form entrypoint to deliver container signals to the JVM. `EXPOSE 8080` documents the application port; configure actual listeners in the application.
- Choose maintained Maven, JDK, and Spring Boot versions compatible with the application. Configure a non-root runtime identity and smoke-test the packaged image.

## Sample Dockerfile

The original sample is preserved verbatim, including its Java 17 image choices and artifact filename.

```dockerfile
#
# Build stage
#
FROM maven:3-eclipse-temurin-17 AS build
COPY src /home/app/src
COPY pom.xml /home/app
RUN mvn -f /home/app/pom.xml clean package
#
# Package stage
#
FROM amazoncorretto:17
COPY --from=build /home/app/target/hello-spring-0.0.1-SNAPSHOT.jar /usr/local/lib/hello-spring.jar
EXPOSE 8080
ENTRYPOINT ["java","-jar","/usr/local/lib/hello-spring.jar"]
```
