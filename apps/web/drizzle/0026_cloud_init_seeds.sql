ALTER TABLE `join_token` ADD `seed_hash` text;--> statement-breakpoint
ALTER TABLE `join_token` ADD `seed` text;--> statement-breakpoint
CREATE UNIQUE INDEX `join_token_seed_hash_unique` ON `join_token` (`seed_hash`);