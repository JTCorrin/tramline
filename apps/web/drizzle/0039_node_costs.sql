ALTER TABLE `node` ADD `region` text;--> statement-breakpoint
ALTER TABLE `node` ADD `offer` text;--> statement-breakpoint
ALTER TABLE `node` ADD `monthly_cost` real;--> statement-breakpoint
-- machines created before this kept their region and size only on the join token they enrolled with
UPDATE `node` SET
	`region` = (SELECT `region` FROM `join_token` WHERE `join_token`.`node_id` = `node`.`id` ORDER BY `created_at` DESC LIMIT 1),
	`offer` = (SELECT `offer` FROM `join_token` WHERE `join_token`.`node_id` = `node`.`id` ORDER BY `created_at` DESC LIMIT 1)
WHERE `adapter_account_id` IS NOT NULL;
