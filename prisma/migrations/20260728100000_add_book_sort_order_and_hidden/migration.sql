-- AlterTable
ALTER TABLE "book" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "book" ADD COLUMN "is_hidden" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "idx_book_sort_order" ON "book"("sort_order");
