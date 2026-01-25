# BS9 Version Management

## 🚀 Automated Version Management

BS9 มีระบบจัดการ version อัตโนมัติสำหรับการอัปเดต incremental versions (1.5.x) และ major versions (1.6.x, 1.7.x)

## 📋 Version Strategy

### 🔄 Incremental Updates (1.5.x)
- **1.5.1 → 1.5.2 → 1.5.3 → ... → 1.5.9 → 1.5.10**
- **สำหรับ**: Feature additions, improvements, bug fixes
- **Auto-update**: CHANGELOG ทุกครั้ง

### 🚀 Major Version Jumps (เมื่อสั่ง)
- **1.5.x → 1.6.0** (Major features)
- **1.6.x → 1.7.0** (Major features)
- **ตามคำสั่งผู้ใช้**

## 🛠️ การใช้งาน

### 📦 Patch Updates (1.5.1 → 1.5.2)
```bash
# อัปเดต version เท่านั้น
bun run version:patch "Added new feature"

# อัปเดตและ publish ทันที
bun run publish:patch "Fixed critical bug"
```

### 🚀 Minor Updates (1.5.x → 1.6.0)
```bash
# อัปเดต version เท่านั้น
bun run version:minor "Added multi-service management"

# อัปเดตและ publish ทันที
bun run publish:minor "Major feature release"
```

### 🎯 Major Updates (1.6.x → 1.7.0)
```bash
# อัปเดต version เท่านั้น
bun run version:major "Complete rewrite of core system"

# อัปเดตและ publish ทันที
bun run publish:major "Major architectural changes"
```

## 🔄 ระบบทำงานอัตโนมัติ

### Step 1: Version Update
- ✅ อัปเดต `package.json`
- ✅ อัปเดต `README.md` version badge
- ✅ อัปเดต `CHANGELOG.md` พร้อมรายละเอียด
- ✅ Git commit พร้อม version tag

### Step 2: Publishing (เฉพาะ publish commands)
- ✅ Push ไป GitHub
- ✅ Publish ไป npm registry
- ✅ แสดงผลลัพธ์สำเร็จ

## 📝 ตัวอย่างการใช้งาน

### Scenario 1: Bug Fix
```bash
bun run publish:patch "Fixed memory leak in status command"
```
ผลลัพธ์: 1.5.1 → 1.5.2

### Scenario 2: Small Feature
```bash
bun run publish:patch "Added timeout option to deploy command"
```
ผลลัพธ์: 1.5.2 → 1.5.3

### Scenario 3: Major Feature (เมื่อสั่ง)
```bash
bun run publish:minor "Added Kubernetes integration"
```
ผลลัพธ์: 1.5.3 → 1.6.0

### Scenario 4: Complete Rewrite (เมื่อสั่ง)
```bash
bun run publish:major "Migrated to Rust core"
```
ผลลัพธ์: 1.6.0 → 2.0.0

## 🎯 คำสั่งพิเศษ

### Manual Version Manager
```bash
# ใช้ script โดยตรง
bun scripts/version-manager.js patch "Custom change description"
bun scripts/version-manager.js minor "Minor feature"
bun scripts/version-manager.js major "Major change"
```

### Auto Publisher
```bash
# ใช้ auto-publish โดยตรง
bun scripts/auto-publish.js patch "Bug fix with auto publish"
bun scripts/auto-publish.js minor "Feature with auto publish"
bun scripts/auto-publish.js major "Major with auto publish"
```

## 📊 Version History

### Current Pattern
- **v1.5.0**: Multi-Service Management (Major Feature)
- **v1.5.1**: Automated Version Management (Patch)
- **v1.5.2**: Next patch update
- **v1.5.3**: Next patch update
- **...**
- **v1.5.9**: Continue patch updates
- **v1.5.10**: Continue patch updates
- **v1.6.0**: Major version (เมื่อสั่ง)

### Future Pattern
- **v1.6.0**: Next major version
- **v1.6.1**: Patch updates
- **v1.6.2**: Patch updates
- **...**
- **v1.7.0**: Next major version (เมื่อสั่ง)

## 🎯 ข้อแนะนำ

1. **Patch Updates**: ใช้สำหรับ bug fixes, small features, improvements
2. **Minor Updates**: ใช้สำหรับ major features ที่ไม่ breaking changes
3. **Major Updates**: ใช้สำหรับ breaking changes หรือ major architectural changes
4. **Auto-publish**: ใช้เมื่อมั่นใจว่าพร้อม publish ทันที
5. **Version-only**: ใช้เมื่อต้องการอัปเดต version ก่อนตรวจสอบ

## 🔧 Configuration

ระบบจัดการ version ถูกตั้งค่าไว้ที่:
- **Scripts**: `scripts/version-manager.js` และ `scripts/auto-publish.js`
- **Package.json**: Scripts สำหรับความสะดวก
- **Changelog**: อัปเดตอัตโนมัติทุกครั้ง
- **Git**: Auto commit และ tag ทุกครั้ง

---

**พร้อมใช้งาน!** 🚀
