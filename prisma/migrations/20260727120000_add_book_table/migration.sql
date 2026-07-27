-- CreateTable
CREATE TABLE "book" (
    "id" BIGSERIAL NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "storage_path" TEXT NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_size" INTEGER NOT NULL,
    "page_count" INTEGER,
    "uploaded_by" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "book_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_book_created_at" ON "book"("created_at");

-- AddForeignKey
ALTER TABLE "book" ADD CONSTRAINT "book_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "useraccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
