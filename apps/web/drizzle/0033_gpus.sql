ALTER TABLE `deployment` ADD `replica_gpus` text;--> statement-breakpoint
ALTER TABLE `join_token` ADD `offer_gpu` text;--> statement-breakpoint
ALTER TABLE `node` ADD `offer_gpu` text;--> statement-breakpoint
ALTER TABLE `node_pool` ADD `gpu` text;