// @bun
setInterval(()=>{console.log(`[TS-APP] Hello from TypeScript at ${new Date().toISOString()}`)},2000);console.log("[TS-APP] Started on port",process.env.PORT||3000);
