import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  await prisma.vocabulary.createMany({
    data: [
      { word: '食べる', meaning: 'to eat', jlpt: 5 },
      { word: '見る', meaning: 'to see', jlpt: 5 }
    ],
    skipDuplicates: true
  });
}

main()
  .catch((e) => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
