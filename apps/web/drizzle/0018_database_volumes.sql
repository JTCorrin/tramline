-- Databases created before volumes existed kept their data on an anonymous
-- Docker volume, lost on the next deploy. Give them their template's volume;
-- it takes effect on their next deploy. (A detached volume is stored as a
-- null mount path, so only configs without the section are touched.)
UPDATE `service_instance`
SET `config` = json_set(`config`, '$.volume', json_object('mountPath', CASE (SELECT `icon` FROM `service` WHERE `service`.`id` = `service_instance`.`service_id`)
	WHEN 'postgres' THEN '/var/lib/postgresql/data'
	WHEN 'mysql' THEN '/var/lib/mysql'
	WHEN 'redis' THEN '/data'
	WHEN 'mongo' THEN '/data/db'
END))
WHERE `config` IS NOT NULL
	AND json_type(`config`, '$.volume') IS NULL
	AND (SELECT `kind` FROM `service` WHERE `service`.`id` = `service_instance`.`service_id`) = 'database'
	AND (SELECT `icon` FROM `service` WHERE `service`.`id` = `service_instance`.`service_id`) IN ('postgres', 'mysql', 'redis', 'mongo');
