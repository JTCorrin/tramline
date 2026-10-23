import {
	DEFAULT_SERVICE_CONFIG,
	type DatabaseEngine,
	type ServiceConfig
} from '@tramline/contracts';
import { randomSecret } from '../crypto';

export interface DatabaseTemplate {
	name: string;
	config: ServiceConfig;
	/** Fresh variables for one environment (passwords differ per environment). */
	variables: () => Record<string, string>;
}

const image = (name: string, port: number, startCommand: string | null = null): ServiceConfig => ({
	...DEFAULT_SERVICE_CONFIG,
	source: { type: 'image', image: name },
	deploy: { ...DEFAULT_SERVICE_CONFIG.deploy, startCommand, restartPolicy: 'always' },
	networking: { port, publicDomain: false }
});

const HOST = '${{TRAMLINE_PRIVATE_DOMAIN}}';

export const DATABASE_TEMPLATES: Record<DatabaseEngine, DatabaseTemplate> = {
	postgres: {
		name: 'Postgres',
		config: image('postgres:17', 5432),
		variables: () => ({
			PGUSER: 'postgres',
			POSTGRES_USER: '${{PGUSER}}',
			POSTGRES_PASSWORD: randomSecret(),
			PGPASSWORD: '${{POSTGRES_PASSWORD}}',
			PGDATABASE: 'app',
			POSTGRES_DB: '${{PGDATABASE}}',
			PGHOST: HOST,
			PGPORT: '5432',
			DATABASE_URL: `postgresql://\${{PGUSER}}:\${{POSTGRES_PASSWORD}}@${HOST}:5432/\${{PGDATABASE}}`
		})
	},
	mysql: {
		name: 'MySQL',
		config: image('mysql:8.4', 3306),
		variables: () => ({
			MYSQL_ROOT_PASSWORD: randomSecret(),
			MYSQL_DATABASE: 'app',
			MYSQLHOST: HOST,
			MYSQLPORT: '3306',
			MYSQL_URL: `mysql://root:\${{MYSQL_ROOT_PASSWORD}}@${HOST}:3306/\${{MYSQL_DATABASE}}`
		})
	},
	redis: {
		name: 'Redis',
		config: image('redis:7', 6379, 'redis-server --requirepass $REDIS_PASSWORD'),
		variables: () => ({
			REDIS_PASSWORD: randomSecret(),
			REDISHOST: HOST,
			REDISPORT: '6379',
			REDIS_URL: `redis://default:\${{REDIS_PASSWORD}}@${HOST}:6379`
		})
	},
	mongo: {
		name: 'MongoDB',
		config: image('mongo:8', 27017),
		variables: () => ({
			MONGO_INITDB_ROOT_USERNAME: 'mongo',
			MONGO_INITDB_ROOT_PASSWORD: randomSecret(),
			MONGOHOST: HOST,
			MONGOPORT: '27017',
			MONGO_URL: `mongodb://\${{MONGO_INITDB_ROOT_USERNAME}}:\${{MONGO_INITDB_ROOT_PASSWORD}}@${HOST}:27017`
		})
	}
};
