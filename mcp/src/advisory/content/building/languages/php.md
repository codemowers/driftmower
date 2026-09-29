# Building PHP containers

Prefer a single container running a long-lived PHP application server over the classic php-fpm plus web server pair. The process boots the framework once, keeps it in memory and serves requests itself, so there is no FastCGI hop, no second container and no web server config to keep in step with the PHP image. Health checks, signals and logs behave like any other application container.

Two common shapes:

- **ReactPHP**, via Framework X or a bare `React\Http\HttpServer`. The application is an event loop; the container's `CMD` runs the entry script and the framework listens on a TCP port directly. Use the `php:*-cli` image, since there is no FPM to run.
- **Laravel Octane**, which boots the application once and serves it from FrankenPHP, Swoole or RoadRunner. FrankenPHP ships its own image with PHP and the server already combined.

In both cases:

- Install every extension the lock file needs in a shared `base` stage and derive the vendor and runtime stages from it, so dependencies are resolved on the same platform they run on.
- Enable OPcache explicitly. It is off by default in the official image. With the application held in memory the cache is only used at boot, but it still makes the boot and any on-demand includes cheaper. Set `opcache.enable_cli=1` when the server runs under the CLI binary, or the setting has no effect.
- Keep PHP and server configuration in files under `.docker/` and `COPY` them into the image, rather than generating them with shell in a `RUN` step. A file can be linted, diffed and shared with local development; an echo chain cannot.
- Install dependencies in a separate `vendor` stage with `--no-dev --no-scripts`, then run the skipped post-install steps in the runtime stage against the vendor tree the image ships.
- Run as a non-root user, listen on an unprivileged port, and use an exec-form `CMD` so `SIGTERM` reaches the server and it can drain in-flight requests.
- Serve static files from the same process or from the platform ingress. Do not add a web server container just for them unless request volume has shown the need, and if it has, the legacy layout below is the pattern to follow.

## Sample Dockerfile: Framework X on ReactPHP

The entry point is `public/index.php`, which builds an `App`, registers routes and calls `$app->run()`. With `X_LISTEN` set the app serves HTTP itself instead of expecting to be run from php-fpm or the built-in server.

```dockerfile
# syntax=docker/dockerfile:1

#
# Base stage
#
FROM php:8.3-cli AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
libzip-dev libicu-dev unzip \
&& docker-php-ext-install -j"$(nproc)" pdo pdo_mysql bcmath zip intl opcache \
&& pecl install redis \
&& docker-php-ext-enable redis \
&& rm -rf /var/lib/apt/lists/*

COPY .docker/php/opcache.ini .docker/php/app.ini /usr/local/etc/php/conf.d/

#
# PHP dependencies stage
#
FROM base AS vendor
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install \
--no-dev \
--no-scripts \
--no-interaction \
--prefer-dist \
--optimize-autoloader

#
# Runtime stage
#
FROM base AS runtime
WORKDIR /app

COPY --chown=www-data:www-data . .
COPY --chown=www-data:www-data --from=vendor /app/vendor ./vendor

ENV X_LISTEN=0.0.0.0:8080
EXPOSE 8080

USER www-data

CMD ["php", "public/index.php"]
```

### Configuration files

`.docker/php/opcache.ini`:

```ini
opcache.enable=1
opcache.enable_cli=1
opcache.memory_consumption=128
opcache.max_accelerated_files=20000
opcache.validate_timestamps=0
```

`.docker/php/app.ini`:

```ini
memory_limit=256M
```

## Sample Dockerfile: Laravel Octane on FrankenPHP

FrankenPHP's image already contains PHP and the server. `install-php-extensions` comes with it and installs the extensions and their build dependencies in one step. Octane's `frankenphp` server keeps the booted application in worker processes; `--workers` and `--max-requests` bound memory growth.

```dockerfile
# syntax=docker/dockerfile:1

#
# Base stage
#
FROM dunglas/frankenphp:1-php8.3 AS base

RUN install-php-extensions pdo_mysql mbstring exif pcntl bcmath gd zip intl opcache redis

COPY .docker/php/opcache.ini .docker/php/uploads.ini /usr/local/etc/php/conf.d/

#
# PHP dependencies stage
#
FROM base AS vendor
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install \
--no-dev \
--no-scripts \
--no-interaction \
--prefer-dist \
--optimize-autoloader

#
# Front-end assets stage
#
FROM node:20-alpine AS assets
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

#
# Runtime stage
#
FROM base AS runtime
WORKDIR /app

COPY --chown=www-data:www-data . .
COPY --chown=www-data:www-data --from=vendor /app/vendor ./vendor
COPY --chown=www-data:www-data --from=assets /app/public/build ./public/build

RUN mkdir -p \
storage/app/public \
storage/framework/cache/data \
storage/framework/sessions \
storage/framework/views \
storage/logs \
bootstrap/cache \
&& chown -R www-data:www-data storage bootstrap/cache

RUN php artisan package:discover --ansi \
&& chown -R www-data:www-data bootstrap/cache

EXPOSE 8080

USER www-data

CMD ["php", "artisan", "octane:frankenphp", "--host=0.0.0.0", "--port=8080", "--workers=4", "--max-requests=500"]
```

### Configuration files

`.docker/php/opcache.ini`:

```ini
opcache.enable=1
opcache.enable_cli=1
opcache.memory_consumption=128
opcache.max_accelerated_files=20000
opcache.validate_timestamps=0
```

`.docker/php/uploads.ini`:

```ini
upload_max_filesize=20M
post_max_size=20M
memory_limit=256M
```

## Legacy: php-fpm with an nginx container

This is the pattern for applications that cannot run under a long-lived server, or whose traffic is mostly static files that a web server should answer without touching PHP. Build one image from the official `php:*-fpm` base and run it as two containers in the same pod: php-fpm as the default command, and nginx started from the same image with its own config. Because both containers come from the same build, the web server always serves the `public/` tree that matches the PHP code it forwards to.

- Install every PHP extension the application needs in a shared `base` stage, and derive the vendor, CI and runtime stages from it. Composer resolves the lock file against the extensions of the PHP it runs on, so installing dependencies on a different platform than production is how a build passes and the pod then fails.
- Enable OPcache explicitly with `opcache.validate_timestamps=0`. It is off by default in the official image, and a production image never changes its files after build.
- Keep PHP's upload and POST limits equal to the web server's body size limit, so a too-large request fails at one place with one error.
- Install dependencies in a separate `vendor` stage with `--no-dev --no-scripts`, so the stage needs only `composer.json` and `composer.lock` and no credentials for development-only packages. Run the skipped post-install steps, such as `package:discover`, in the runtime stage against the vendor tree the image actually ships.
- Build front-end assets in a Node stage and copy only the built output into the runtime image.
- Create the writable directories the framework expects, such as `storage/` and `bootstrap/cache`, at build time and hand them to the runtime user.
- Bind php-fpm to loopback only. FastCGI has no authentication, so anything that can reach the port can execute code with the application's secrets.
- Run as a non-root user and use an exec-form `CMD` so signals reach php-fpm.

### Sample Dockerfile

```
# syntax=docker/dockerfile:1

#
# Base stage
#
FROM php:8.3-fpm AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
libpng-dev libjpeg-dev libwebp-dev libfreetype6-dev \
libonig-dev libxml2-dev libzip-dev libicu-dev libcurl4-openssl-dev \
zlib1g-dev g++ unzip \
&& docker-php-ext-configure gd --with-jpeg --with-webp --with-freetype \
&& docker-php-ext-install -j"$(nproc)" \
pdo pdo_mysql mbstring exif pcntl bcmath gd zip intl opcache \
&& pecl install redis \
&& docker-php-ext-enable redis \
&& apt-get purge -y g++ \
&& apt-get autoremove -y \
&& rm -rf /var/lib/apt/lists/*

COPY .docker/php/opcache.ini .docker/php/uploads.ini /usr/local/etc/php/conf.d/

#
# PHP dependencies stage
#
FROM base AS vendor
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install \
--no-dev \
--no-scripts \
--no-interaction \
--prefer-dist \
--optimize-autoloader

#
# Runtime stage
#
FROM base AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends nginx \
&& rm -rf /var/lib/apt/lists/* \
&& rm -f /etc/nginx/sites-enabled/default

COPY .docker/nginx/kube.conf .docker/nginx/upstream.kube.conf .docker/nginx/server.conf /etc/nginx/

WORKDIR /var/www/html

COPY --chown=www-data:www-data . .
COPY --chown=www-data:www-data --from=vendor /app/vendor ./vendor
COPY --chown=www-data:www-data --from=assets /app/public/build ./public/build

RUN mkdir -p \
storage/app/public \
storage/framework/cache/data \
storage/framework/sessions \
storage/framework/views \
storage/logs \
bootstrap/cache \
&& chown -R www-data:www-data storage bootstrap/cache

RUN php artisan package:discover --ansi \
&& php artisan filament:assets --ansi \
&& chown -R www-data:www-data bootstrap/cache

COPY .docker/php-fpm/zz-listen.conf /usr/local/etc/php-fpm.d/

USER www-data

CMD ["php-fpm"]
```

### Configuration files

`.docker/php/opcache.ini`:

```ini
opcache.enable=1
opcache.enable_cli=0
opcache.memory_consumption=128
opcache.max_accelerated_files=20000
opcache.validate_timestamps=0
```

`.docker/php/uploads.ini`, matching the `client_max_body_size` in the nginx server block:

```ini
upload_max_filesize=20M
post_max_size=20M
memory_limit=256M
```

`.docker/php-fpm/zz-listen.conf`. The base image's `docker.conf` listens on every interface; `php-fpm.d` is read in order, so the `zz-` prefix makes this file win:

```ini
[www]
listen = 127.0.0.1:9000
```

`.docker/nginx/kube.conf` is the main config for the nginx container, started as `nginx -c /etc/nginx/kube.conf -g 'daemon off;'`. It runs unprivileged, so the pid file and every scratch path are under `/tmp` and logs go to stdout and stderr. It includes the other two files:

```nginx
worker_processes auto;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;

events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    access_log /dev/stdout;

    sendfile      on;
    tcp_nopush    on;
    server_tokens off;

    client_body_temp_path /tmp/client_body;
    proxy_temp_path       /tmp/proxy;
    fastcgi_temp_path     /tmp/fastcgi;
    uwsgi_temp_path       /tmp/uwsgi;
    scgi_temp_path        /tmp/scgi;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript
               application/xml image/svg+xml;
    gzip_min_length 1024;

    include /etc/nginx/upstream.kube.conf;
    include /etc/nginx/server.conf;
}
```

`.docker/nginx/upstream.kube.conf`. php-fpm is the other container in the same pod, so it answers on loopback. A docker-compose variant of this one file points at the php-fpm service instead; everything else is shared:

```nginx
upstream php_backend {
    server 127.0.0.1:9000;
}
```

`.docker/nginx/server.conf`, the server block shared with local development. It listens on an unprivileged port, serves static files directly, and sets cache headers on uploaded assets and on Vite's content-hashed build output:

```nginx
server {
    listen 8080;
    server_name _;

    root /var/www/html/public;
    index index.php index.html;

    client_max_body_size 20M;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ^~ /cms-assets {
        alias /var/www/html/storage/app/public;
        access_log off;
        add_header Cache-Control "public, max-age=604800" always;
    }

    location ^~ /build/ {
        access_log off;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    location ~ \.php$ {
        include fastcgi_params;
        fastcgi_pass php_backend;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_read_timeout 300;
    }

    location ~ /\.(?!well-known) {
        deny all;
    }
}
```

