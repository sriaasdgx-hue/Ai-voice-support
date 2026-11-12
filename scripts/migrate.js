import {loadConfig} from '../src/config.js';
import {PostgresStore} from '../src/store.js';
const store = new PostgresStore(loadConfig());
try {await store.init(); console.log('Assistant database is ready.');} finally {await store.close();}
