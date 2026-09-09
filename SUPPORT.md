# BS9 Support

## 🤝 Getting Help

BS9 is a community-driven open source project. We offer multiple ways to get help and support.

## 🆘 Quick Help

### Self-Service Resources

**📚 Documentation**
- [README.md](README.md) - Getting started guide and CLI reference
- [INSTALL.md](INSTALL.md) - Complete installation instructions
- [CONTRIBUTING.md](CONTRIBUTING.md) - Development and contribution guidelines
- [SECURITY.md](SECURITY.md) - Security policy and vulnerability reporting
- [PRODUCTION.md](PRODUCTION.md) - Production deployment guidelines
- [FAQ.md](FAQ.md) - Frequently asked questions

**🔧 Common Commands**
```bash
# Get help
bs9 --help
bs9 <command> --help

# Check status of services
bs9 status

# View logs
bs9 logs <service-name>

# Real-time terminal monitor
bs9 monit

# Web dashboard
bs9 web --port 8080

# Update BS9
bs9 update
```

**🐛 Troubleshooting**
```bash
# Check BS9 version
bs9 -V

# Verify installation & health
bs9 doctor --verbose

# Run system inspection
bs9 inspect
```

## 💬 Community Support

### GitHub Discussions
**For questions, discussions, and feature ideas:**
- 📝 [GitHub Discussions](https://github.com/xarhang/bs9/discussions)
- ❓ Questions and answers
- 💡 Ideas and suggestions
- 📖 Show and tell
- 🎯 Architecture and design discussions

### GitHub Issues
**For bug reports and verified issues:**
- 🐛 [GitHub Issues](https://github.com/xarhang/bs9/issues)
- 🔒 [Security Advisories](https://github.com/xarhang/bs9/security/advisories/new) (for security vulnerabilities)

## 🐛 Bug Reports

### Reporting Issues

**Before reporting:**
1. Search [existing issues](https://github.com/xarhang/bs9/issues) for duplicates
2. Try the latest version (`bs9 update` or pull latest git changes)
3. Run `bs9 doctor --verbose` to check your environment
4. Provide minimal steps to reproduce

**How to report:**
1. Go to [GitHub Issues](https://github.com/xarhang/bs9/issues)
2. Click "New issue"
3. Provide detailed environment information

### Issue Templates

**Bug Report Template:**
```markdown
## Bug Description
Brief description of the issue

## Environment
- BS9 version: `bs9 -V`
- Operating system: Linux / macOS / Windows
- Bun version: `bun -v`

## Steps to Reproduce
1. Step one
2. Step two
3. Step three

## Expected Behavior
What should happen

## Actual Behavior
What actually happens

## Error Messages & Logs
Include full error messages, stack traces, or relevant output from `bs9 logs`

## Additional Context
Any other relevant information
```

**Feature Request Template:**
```markdown
## Feature Description
Clear description of the feature

## Use Case
Why do you need this feature?

## Proposed Solution
How should it work?

## Alternatives Considered
Other approaches you've thought about
```

## 📚 Learning Resources

### Documentation
- [Installation Guide](INSTALL.md)
- [CLI Commands Reference](docs/COMMANDS.md)
- [API Reference](docs/API.md)
- [Architecture Overview](ARCHITECTURE.md)
- [Production Deployment](PRODUCTION.md)
- [Security Policy](SECURITY.md)

### Example Applications
- [Examples Directory](examples/)
- [Database-connected Example](examples/database-app.js)
- [Simple App Example](examples/simple-app.js)

## 🔄 Support Best Practices

**For the quickest help, always include:**
- BS9 version (`bs9 -V`)
- Operating system and version (`uname -a` or Windows build)
- Bun version (`bun -v`)
- Full command executed and terminal output
- Diagnostics output from `bs9 doctor`

---

*Last Updated: September 10, 2026*  
*BS9 Version: 1.5.20*  
*Maintained by: [@xarhang](https://github.com/xarhang)*
