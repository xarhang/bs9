# Contributing to BS9 (Bun Sentinel 9)

Thank you for your interest in contributing to BS9! This document provides guidelines and information for contributors.

## Our Mission

BS9 is a 100% open-source, community-driven project. We believe in making enterprise-grade process management available to everyone. All project code is licensed under `AGPL-3.0-or-later`.

## 🤝 Why Contribute?

- **Impact**: Help millions of developers manage their applications better
- **Learning**: Work with modern TypeScript, Bun, and enterprise technologies
- **Community**: Join a growing community of passionate developers
- **Recognition**: Get your work recognized and used globally
- **Growth**: Build your portfolio and skills with real-world projects

## Development Setup

### Prerequisites
- Bun runtime (latest version)
- Linux/macOS/Windows (cross-platform support)
- Git
- Docker (optional, for container development)
- kubectl (optional, for Kubernetes development)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/xarhang/bs9.git
cd bs9

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

# Run tests
bun test
```

## 🎯 Contribution Areas

We welcome contributions in all areas! Here are some high-priority areas:

### 🔧 Core Features
- **CLI Commands**: New commands, improvements to existing ones
- **Monitoring**: Advanced dashboards, metrics collection
- **Security**: Security hardening, vulnerability scanning
- **Performance**: Optimization, memory management
- **Cross-platform**: Windows, macOS, Linux improvements

### 📚 Documentation
- **Tutorials**: Step-by-step guides for different use cases
- **API Docs**: Comprehensive API documentation
- **Examples**: Real-world application examples
- **Translations**: Localize documentation for different languages

### 🧪 Testing
- **Unit Tests**: Increase test coverage
- **Integration Tests**: End-to-end testing
- **Performance Tests**: Benchmarking and profiling
- **Security Tests**: Vulnerability scanning

### 🌐 Ecosystem
- **Plugins**: Third-party integrations
- **Tools**: Development tools and utilities
- **Templates**: Configuration templates
- **Docker/K8s**: Container and orchestration support

### 🎨 Design & UX
- **Web UI**: Dashboard improvements
- **CLI UX**: Better command-line experience
- **Documentation**: Better organization and clarity
- **Branding**: Visual design improvements

## 📁 Project Structure

```
BS9/
├── bin/
│   └── bs9                     # CLI entry point
├── src/
│   ├── commands/               # One module per CLI command
│   ├── cluster/                # Worker lifecycle and authenticated control
│   ├── daemon/                 # Desired-state topology reconciler
│   ├── hub/                    # State, WAL, leases, and durable queues
│   ├── runtime/                # Public typed runtime client
│   ├── platform/               # Platform detection and paths
│   ├── alerting/               # Alert configuration
│   ├── database/               # Database monitoring helpers
│   ├── discovery/              # Service discovery
│   ├── loadbalancer/           # Load-balancer integration
│   ├── monitoring/             # Runtime monitoring
│   ├── storage/                # Metrics persistence
│   ├── injectors/              # Runtime auto-injection
│   ├── mcp/                    # MCP integration
│   ├── web/                    # Web dashboard
│   ├── windows/                # Windows service support
│   ├── macos/                  # launchd support
│   ├── docker/                 # Container assets
│   ├── k8s/                    # Kubernetes manifests
│   ├── utils/                  # Shared utilities
│   └── index.ts                # Package exports
├── tests/                  # Bun unit and integration tests
├── docs/                   # Command, API, and HA documentation
├── examples/               # Runnable example applications
├── configs/                # Service configuration templates
├── scripts/                # Build, release, and verification tools
├── marketplace/            # Plugin examples
├── setup.sh                # One-click installer
├── docker-compose.yml      # Docker Compose stack
├── package.json            # Package metadata and scripts
└── README.md               # Project overview
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

By submitting a contribution to BS9, you agree that your contribution is licensed under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`). Only submit work that you have the right to license under these terms.
