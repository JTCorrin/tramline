ALTER TABLE `node` ADD `edge` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `node` ADD `mesh_public_key` text;--> statement-breakpoint
ALTER TABLE `node` ADD `mesh_address` text;--> statement-breakpoint
ALTER TABLE `node` ADD `mesh_endpoint` text;--> statement-breakpoint
CREATE UNIQUE INDEX `node_mesh_address_unique` ON `node` (`mesh_address`);--> statement-breakpoint
-- the node next to the control plane has served every domain so far
UPDATE `node` SET `edge` = 1 WHERE `name` = 'local';
