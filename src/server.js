import {loadConfig} from './config.js';
import {createBackend} from './app.js';
try {
  const config=loadConfig();const backend=await createBackend(config);
  backend.server.listen(config.PORT,'0.0.0.0',()=>console.log('SRIAAS assistant listening',{port:backend.server.address().port,auth:config.AUTH_MODE,models:config.MODEL_TRANSPORT,storage:config.STORAGE}));
  let stopping=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(stopping)return;stopping=true;void backend.close().catch(()=>{process.exitCode=1;});});
}catch(error){console.error('Startup failed:',error.name==='ZodError'?'Invalid environment configuration. Check .env.example.':error.message);process.exitCode=1;}
