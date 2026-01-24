# BS9 Docker Image
FROM oven/bun:1.3.6-alpine

# Install system dependencies
RUN apk add --no-cache \
    systemd \
    curl \
    bash \
    && rm -rf /var/cache/apk/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json bun.lockb ./

# Install dependencies
RUN bun install --frozen-lockfile --production

# Copy BS9 source code
COPY bin/ ./bin/
COPY src/ ./src/

# Create necessary directories
RUN mkdir -p /app/.config/bs9 /app/.config/systemd/user

# Make BS9 executable
RUN chmod +x /app/bin/bs9

# Add BS9 to PATH
ENV PATH="/app/bin:${PATH}"

# Expose web dashboard port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/ || exit 1

# Set up systemd for user mode
RUN echo "user" > /etc/hostname

# Default command
CMD ["/bin/bash"]
