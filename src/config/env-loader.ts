import * as dotenv from 'dotenv';
import * as path from 'path';

const root = process.cwd();
dotenv.config({ path: path.resolve(root, '.env.local') });
dotenv.config({ path: path.resolve(root, '.env') });
