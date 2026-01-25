# BS9 Version Management

## 🚀 Automated Version Management

BS9 includes an automated version management system for incremental versions (1.5.x) and major versions (1.6.x, 1.7.x)

## 📋 Version Strategy

### 🔄 Incremental Updates (1.5.x)
- **1.5.1 → 1.5.2 → 1.5.3 → ... → 1.5.9 → 1.5.10**
- **For**: Feature additions, improvements, bug fixes
- **Auto-update**: CHANGELOG every time

### 🚀 Major Version Jumps (when commanded)
- **1.5.x → 1.6.0** (Major features)
- **1.6.x → 1.7.0** (Major features)
- **When**: User commanded

## 🛠️ Usage

### 📦 Patch Updates (1.5.1 → 1.5.2)
```bash
# Version update only
bun run version:patch "Added new feature"

# Update and publish immediately
bun run publish:patch "Fixed critical bug"
```

### 🚀 Minor Updates (1.5.x → 1.6.0)
```bash
# Version update only
bun run version:minor "Added multi-service management"

# Update and publish immediately
bun run publish:minor "Major feature release"
```

### 🎯 Major Updates (1.6.x → 1.7.0)
```bash
# Version update only
bun run version:major "Complete rewrite of core system"

# Update and publish immediately
bun run publish:major "Major architectural changes"
```

## 🔄 Automated Workflow

### Step 1: Version Update
- ✅ Update `package.json`
- ✅ Update `README.md` version badge
- ✅ Update `CHANGELOG.md` with details
- ✅ Git commit with version tag

### Step 2: Publishing (publish commands only)
- ✅ Push to GitHub
- ✅ Publish to npm registry
- ✅ Show success results

## 📝 Usage Examples

### Scenario 1: Bug Fix
```bash
bun run publish:patch "Fixed memory leak in status command"
```
Result: 1.5.1 → 1.5.2

### Scenario 2: Small Feature
```bash
bun run publish:patch "Added timeout option to deploy command"
```
Result: 1.5.2 → 1.5.3

### Scenario 3: Major Feature (when commanded)
```bash
bun run publish:minor "Added Kubernetes integration"
```
Result: 1.5.3 → 1.6.0

### Scenario 4: Complete Rewrite (when commanded)
```bash
bun run publish:major "Migrated to Rust core"
```
Result: 1.6.0 → 2.0.0

## 🎯 Special Commands

### Manual Version Manager
```bash
# Use script directly
bun scripts/version-manager.js patch "Custom change description"
bun scripts/version-manager.js minor "Minor feature"
bun scripts/version-manager.js major "Major change"
```

### Test Publisher (no npm publish)
```bash
# Test without publishing
bun scripts/test-publish.js patch "Bug fix test"
bun scripts/test-publish.js minor "Feature test"
bun scripts/test-publish.js major "Major change test"
```

### Auto Publisher
```bash
# Use auto-publish directly
bun scripts/auto-publish.js patch "Bug fix with auto publish"
bun scripts/auto-publish.js minor "Feature with auto publish"
bun scripts/auto-publish.js major "Major with auto publish"
```

## 📊 Version History

### Current Pattern
- **v1.5.0**: Multi-Service Management (Major Feature)
- **v1.5.1**: Automated Version Management (Patch)
- **v1.5.2**: Test Version Management (Patch)
- **v1.5.3**: Testing Version System (Patch)
- **v1.5.4**: Next patch update
- **v1.5.5**: Next patch update
- **...**
- **v1.5.9**: Continue patch updates
- **v1.5.10**: Continue patch updates
- **v1.6.0**: Major version (when commanded)

### Future Pattern
- **v1.6.0**: Next major version
- **v1.6.1**: Patch updates
- **v1.6.2**: Patch updates
- **...**
- **v1.7.0**: Next major version (when commanded)

## 🎯 Recommendations

1. **Patch Updates**: Use for bug fixes, small features, improvements
2. **Minor Updates**: Use for major features without breaking changes
3. **Major Updates**: Use for breaking changes or major architectural changes
4. **Auto-publish**: Use when confident and ready to publish immediately
5. **Version-only**: Use when you want to update version before review

## 🔧 Configuration

Version management system is configured at:
- **Scripts**: `scripts/version-manager.js` and `scripts/auto-publish.js`
- **Package.json**: Convenience scripts
- **Changelog**: Auto-updated every time
- **Git**: Auto commit and tag every time

## 📋 Available Scripts

### Version Management
```bash
bun run version:patch    # Update patch version
bun run version:minor    # Update minor version
bun run version:major    # Update major version
```

### Publishing
```bash
bun run publish:patch    # Update and publish patch
bun run publish:minor    # Update and publish minor
bun run publish:major    # Update and publish major
```

### Testing
```bash
bun run test:patch       # Test patch without publish
bun run test:minor       # Test minor without publish
bun run test:major       # Test major without publish
```

## 🎯 Quick Start

### For Quick Bug Fix
```bash
bun run publish:patch "Quick bug fix"
```

### For Feature Development
```bash
bun run test:patch "Testing new feature"
# Review changes
bun run publish:patch "Feature completed"
```

### For Major Release (when commanded)
```bash
bun run publish:minor "Major feature release"
```

---

**Ready to use!** 🚀
