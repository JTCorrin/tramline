ALTER TABLE `join_token` ADD `spot` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `node` ADD `spot` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `node` ADD `reclaimed_at` integer;--> statement-breakpoint
ALTER TABLE `node_pool` ADD `spot` integer DEFAULT false NOT NULL;