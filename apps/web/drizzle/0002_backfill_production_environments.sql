-- Projects created before environments existed get their default `production` environment.
INSERT INTO `environment` (`id`, `project_id`, `name`)
SELECT 'env_' || lower(hex(randomblob(13))), `id`, 'production'
FROM `project`
WHERE `id` NOT IN (SELECT `project_id` FROM `environment`);
