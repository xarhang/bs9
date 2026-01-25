# Module 1: Introduction to BS9

## 🎯 Module Overview

This module introduces BS9 (Bun Sentinel 9), covering what it is, why it's needed, and how to get started with your first BS9-managed application.

## 📚 Learning Objectives

After completing this module, you will be able to:
- Understand what BS9 is and its purpose
- Install BS9 on your system
- Create and manage your first BS9 application
- Understand basic BS9 concepts and terminology
- Navigate the BS9 CLI interface

## 📋 Module Structure

### Lesson 1: What is BS9?
**Duration:** 30 minutes

#### 🎯 Topics Covered
- Process management concepts
- BS9 vs other process managers
- Key features and benefits
- Use cases and applications
- BS9 architecture overview

#### 📝 Key Concepts
- **Process Manager**: Software that manages application processes
- **Service**: An application managed by BS9
- **Daemon**: Background process
- **PID**: Process ID
- **Uptime**: Time since process started

#### 🎯 Learning Activities
- Watch introduction video (10 minutes)
- Read BS9 overview documentation (10 minutes)
- Complete concept quiz (10 minutes)

---

### Lesson 2: Installation and Setup
**Duration:** 45 minutes

#### 🎯 Topics Covered
- System requirements
- Installation methods
- Verification steps
- Configuration basics
- Troubleshooting installation

#### 🛠️ Hands-on Exercises
- Install BS9 using setup script
- Verify installation
- Check system compatibility
- Configure basic settings

#### 📋 Installation Commands
```bash
# One-click installation
curl -fsSL https://raw.githubusercontent.com/xarhang/bs9/setup.sh | bash

# Verify installation
bs9 --version
bs9 doctor

# Check system compatibility
bs9 check
```

---

### Lesson 3: First Application
**Duration:** 60 minutes

#### 🎯 Topics Covered
- Creating a simple application
- Starting with BS9
- Service configuration
- Basic monitoring
- Service management

#### 🛠️ Hands-on Exercises
- Create a simple Bun application
- Start the application with BS9
- Monitor the service
- Stop and restart the service
- View logs and status

#### 📄 Sample Application
```javascript
// hello-world.js
import { serve } from "bun";

serve({
  port: 3000,
  fetch(req) {
    return new Response("Hello from BS9!");
  }
});
```

#### 🔧 BS9 Commands
```bash
# Start the application
bs9 start hello-world.js --name hello-world

# Check status
bs9 status hello-world

# View logs
bs9 logs hello-world

# Stop the service
bs9 stop hello-world
```

---

### Lesson 4: Basic Concepts
**Duration:** 45 minutes

#### 🎯 Topics Covered
- BS9 terminology
- Service lifecycle
- Configuration options
- Environment variables
- Resource management

#### 📝 Key Terms
- **Service**: Application managed by BS9
- **Instance**: Running copy of a service
- **Configuration**: Service settings
- **Environment**: Runtime environment
- **Resources**: CPU, memory, disk usage

#### 🎯 Learning Activities
- Study terminology guide
- Complete concept matching exercise
- Practice with configuration examples
- Take terminology quiz

---

## 🎯 Practical Exercises

### Exercise 1: Installation Practice
**Objective:** Successfully install and verify BS9

**Steps:**
1. Install BS9 using the setup script
2. Verify the installation
3. Check system compatibility
4. Run a health check

**Expected Outcome:**
- BS9 installed and working
- System compatibility confirmed
- Health check passes

### Exercise 2: First Service
**Objective:** Create and manage your first BS9 service

**Steps:**
1. Create a simple application
2. Start it with BS9
3. Monitor the service
4. View logs and status
5. Stop the service

**Expected Outcome:**
- Application running under BS9
- Service status and logs accessible
- Service properly stopped

### Exercise 3: Configuration Practice
**Objective:** Practice basic service configuration

**Steps:**
1. Start a service with environment variables
2. Configure resource limits
3. Set restart policy
4. Test configuration changes

**Expected Outcome:**
- Service configured with custom settings
- Configuration applied correctly
- Service behavior as expected

## 📊 Assessment

### 📝 Module Quiz
**Duration:** 15 minutes  
**Questions:** 10 multiple-choice questions  
**Passing Score:** 80%

**Topics Covered:**
- BS9 concepts and terminology
- Installation procedures
- Basic service management
- Configuration options

### 🔧 Practical Assessment
**Duration:** 30 minutes  
**Tasks:** 3 practical exercises

**Assessment Criteria:**
- Correct installation of BS9
- Successful service management
- Proper configuration application
- Troubleshooting basic issues

## 📚 Additional Resources

### 📖 Reading Materials
- [BS9 Documentation](../../README.md)
- [Installation Guide](../../README.md#-quick-start)
- [CLI Commands](../../docs/COMMANDS.md)
- [API Documentation](../../docs/API.md)

### 🎥 Video Resources
- Introduction to BS9 (10 minutes)
- Installation Guide (15 minutes)
- First Application Tutorial (20 minutes)
- Basic Concepts Overview (15 minutes)

### 🔧 Tools and Utilities
- BS9 CLI tool
- Sample applications
- Configuration templates
- Troubleshooting guides

## 🎯 Common Issues and Solutions

### ❌ Installation Issues

#### Problem: Permission Denied
```bash
# Solution: Use sudo or fix permissions
sudo ./setup.sh
# or
chmod +x setup.sh
./setup.sh
```

#### Problem: Network Issues
```bash
# Solution: Check network connectivity
curl -I https://raw.githubusercontent.com/xarhang/bs9/setup.sh
# or use alternative download method
```

#### Problem: Dependency Issues
```bash
# Solution: Install dependencies manually
# Check system requirements
bs9 doctor
```

### ❌ Service Issues

#### Problem: Service Won't Start
```bash
# Solution: Check logs and configuration
bs9 logs service-name
bs9 status service-name --detailed
```

#### Problem: Port Conflicts
```bash
# Solution: Use different port
bs9 start app.js --name my-app --port 3001
# or check what's using the port
lsof -i :3000
```

#### Problem: Resource Limits
```bash
# Solution: Adjust resource limits
bs9 start app.js --name my-app --memory 512M --cpu 0.5
```

## 🎯 Next Steps

After completing this module, you should:
- ✅ Have BS9 installed and working
- ✅ Understand basic BS9 concepts
- ✅ Be able to start and manage services
- ✅ Know how to troubleshoot basic issues

### 📚 Continue to Module 2
**Module 2: Core Commands** - Learn about BS9's core commands and advanced service management.

### 🔧 Practice Exercises
- Create multiple services
- Experiment with different configurations
- Practice troubleshooting
- Explore monitoring features

### 🤝 Community Engagement
- Join the BS9 Discord community
- Ask questions in forums
- Share your experiences
- Help other learners

---

*Module Duration: 3 hours*
*Difficulty Level: Beginner*
*Prerequisites: Basic JavaScript/Bun knowledge*
