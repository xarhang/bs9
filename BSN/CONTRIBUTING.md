# Contributing to BS9 (Bun Sentinel 9)

Thank you for your interest in contributing to BS9! This document provides guidelines and information for contributors.

## Development Setup

### Prerequisites
- Bun runtime (latest version)
- Linux/macOS with systemd user mode support
- Git
- Docker (optional, for container development)
- kubectl (optional, for Kubernetes development)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/xarhang/bsn.git
cd bsn

# Install dependencies
bun install

# Run CLI in development
bun run bin/bs9 --help

# Run monitoring dashboard
bun run bin/bs9 monit

# Run web dashboard
bun run bin/bs9 web

# Build for distribution
bun run build
```

## Project Structure

```
BS9/
├── bin/
│   └── bs9                 # CLI entry point
├── src/
│   ├── commands/           # CLI command implementations
│   │   ├── start.ts        # Start command with security audit
│   │   ├── stop.ts         # Stop command
│   │   ├── restart.ts      # Restart command
│   │   ├── status.ts       # Status with SRE metrics
│   │   ├── logs.ts         # Logs via journalctl
│   │   ├── monit.ts        # Real-time monitoring dashboard
│   │   ├── web.ts          # Web-based dashboard
│   │   ├── alert.ts        # Alert management
│   │   └── export.ts       # Historical data export
│   ├── web/                # Web dashboard
│   │   └── dashboard.ts    # Web server implementation
│   ├── storage/            # Metrics storage system
│   │   └── metrics.ts       # Historical data management
│   ├── alerting/           # Alert system
│   │   └── config.ts       # Alert configuration
│   ├── injectors/          # Auto-injection modules
│   │   └── otel.ts         # OpenTelemetry injection
│   ├── docker/             # Docker containerization
│   │   └── Dockerfile       # Production container
│   └── k8s/                # Kubernetes manifests
│       └── bs9-deployment.yaml
├── examples/
│   ├── simple-app.js       # Example JavaScript app
│   └── typescript-app.ts   # Example TypeScript app
├── configs/                # Configuration templates
├── docker-compose.yml      # Docker Compose stack
├── setup.sh               # One-click installer
├── package.json
└── README.md
```

## Code Style

### TypeScript
- Use TypeScript for all new code
- Follow existing code patterns
- Include proper type annotations
- Use ES modules (`import`/`export`)

### File Organization
- Commands go in `src/commands/`
- Each command in its own file
- Export functions as named exports
- Use proper error handling

### Naming Conventions
- Files: kebab-case (`start-command.ts`)
- Functions: camelCase (`startCommand`)
- Variables: camelCase
- Constants: UPPER_SNAKE_CASE

## Testing

### Running Tests
```bash
# Run all tests
bun test

# Run specific test file
bun test start.test.ts

# Run tests in watch mode
bun test --watch
```

### Writing Tests
- Test files should end in `.test.ts` or `.spec.ts`
- Test both success and failure cases
- Mock external dependencies (systemctl, journalctl)
- Include integration tests where possible

Example test structure:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { startCommand } from "../src/commands/start.js";

describe("startCommand", () => {
  beforeEach(() => {
    // Setup
  });

  afterEach(() => {
    // Cleanup
  });

  it("should start a service successfully", async () => {
    // Test implementation
  });

  it("should fail on security audit", async () => {
    // Test implementation
  });
});
```

## Submitting Changes

### Branch Naming
- `feature/your-feature-name`
- `bugfix/your-bugfix-name`
- `docs/your-docs-update`
- `refactor/your-refactor-name`

### Commit Messages
Follow conventional commits:
- `feat: add new feature`
- `fix: resolve issue`
- `docs: update documentation`
- `refactor: improve code structure`
- `test: add tests`

Example:
```
feat: add TypeScript AOT compilation

- Add --build flag to start command
- Implement TypeScript compilation with bun build
- Update documentation with examples
- Add tests for AOT functionality

Closes #123
```

### Pull Request Process

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Update documentation
6. Submit a pull request

PR Template:
```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Added tests for new functionality
- [ ] All tests pass
- [ ] Manual testing completed

## Checklist
- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] Tests added/updated
```

## Development Guidelines

### Security Considerations
- Never commit sensitive information
- Validate all user inputs
- Follow principle of least privilege
- Use parameterized queries for database operations

### Performance
- Minimize external command calls
- Use efficient data structures
- Consider memory usage
- Profile critical paths

### Error Handling
- Use descriptive error messages
- Include context in errors
- Handle edge cases gracefully
- Provide helpful troubleshooting information

## Reporting Issues

When reporting bugs, please include:
- BSN version
- Operating system
- Bun version
- Steps to reproduce
- Expected vs actual behavior
- Error messages/logs

## Feature Requests

Feature requests should include:
- Use case description
- Proposed implementation
- Alternative approaches considered
- Potential impact on existing functionality

## Community

### Code of Conduct
Be respectful and inclusive. Follow the [Contributor Covenant](https://www.contributor-covenant.org/).

### Getting Help
- GitHub Issues: Report bugs and request features
- Discussions: Ask questions and share ideas
- Documentation: Check existing docs first

## Release Process

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Create release tag
4. Build and test distribution
5. Publish release notes

## License

By contributing to BS9, you agree that your contributions will be licensed under the MIT License.
