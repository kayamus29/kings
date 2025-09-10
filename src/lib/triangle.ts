import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Triangle position structure
const TRIANGLE_STRUCTURE = [
  // Level 1 (1 position)
  { level: 1, position: 0, key: 'A' },
  
  // Level 2 (2 positions)
  { level: 2, position: 0, key: 'AB1' },
  { level: 2, position: 1, key: 'AB2' },
  
  // Level 3 (4 positions)
  { level: 3, position: 0, key: 'B1C1' },
  { level: 3, position: 1, key: 'B1C2' },
  { level: 3, position: 2, key: 'B2C1' },
  { level: 3, position: 3, key: 'B2C2' },
  
  // Level 4 (8 positions)
  { level: 4, position: 0, key: 'C1D1' },
  { level: 4, position: 1, key: 'C1D2' },
  { level: 4, position: 2, key: 'C2D1' },
  { level: 4, position: 3, key: 'C2D2' },
  { level: 4, position: 4, key: 'C3D1' },
  { level: 4, position: 5, key: 'C3D2' },
  { level: 4, position: 6, key: 'C4D1' },
  { level: 4, position: 7, key: 'C4D2' },
]

export async function createTriangle(planType: string) {
  const triangle = await prisma.triangle.create({
    data: {
      planType: planType as any,
      isComplete: false,
      payoutProcessed: false,
    }
  })

  // Create all 15 positions for the triangle
  const positions = TRIANGLE_STRUCTURE.map(pos => ({
    triangleId: triangle.id,
    level: pos.level,
    position: pos.position,
    positionKey: pos.key,
    userId: null,
  }))

  await prisma.trianglePosition.createMany({
    data: positions
  })

  return triangle
}

export async function assignUserToTriangle(userId: string, referrerId?: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { upline: true }
  })

  if (!user) {
    throw new Error('User not found')
  }

  let targetTriangle = null

  // 1. If user has a referrer, try to place them in referrer's triangle
  if (referrerId || user.uplineId) {
    const referrer = await prisma.user.findUnique({
      where: { id: referrerId || user.uplineId! },
      include: { 
        trianglePosition: {
          include: { triangle: true },
          orderBy: { createdAt: 'desc' } // Get newest positions first
        }
      }
    })

    // Get the most recent triangle position for the referrer
    const referrerTrianglePosition = referrer?.trianglePosition?.[0]

    if (referrerTrianglePosition?.triangle && 
        referrerTrianglePosition.triangle.planType === user.plan &&
        !referrerTrianglePosition.triangle.isComplete) {
      
      // Check if there's an available position in referrer's triangle
      const availablePosition = await prisma.trianglePosition.findFirst({
        where: {
          triangleId: referrerTrianglePosition.triangleId,
          userId: null
        },
        orderBy: [
          { level: 'asc' },
          { position: 'asc' }
        ]
      })

      if (availablePosition) {
        targetTriangle = referrerTrianglePosition.triangle
      }
    }
  }

  // 2. If no referrer triangle available, find oldest available triangle
  if (!targetTriangle) {
    targetTriangle = await prisma.triangle.findFirst({
      where: {
        planType: user.plan,
        isComplete: false,
        positions: {
          some: {
            userId: null
          }
        }
      },
      orderBy: { createdAt: 'asc' }
    })
  }

  // 3. If no available triangle, create a new one
  if (!targetTriangle) {
    targetTriangle = await createTriangle(user.plan)
  }

  // Find the next available position in the triangle
  const availablePosition = await prisma.trianglePosition.findFirst({
    where: {
      triangleId: targetTriangle.id,
      userId: null
    },
    orderBy: [
      { level: 'asc' },
      { position: 'asc' }
    ]
  })

  if (!availablePosition) {
    throw new Error('No available positions in triangle')
  }

  // Assign user to position
  await prisma.trianglePosition.update({
    where: { id: availablePosition.id },
    data: { userId: userId }
  })

  // Check if triangle is now complete
  const filledPositions = await prisma.trianglePosition.count({
    where: {
      triangleId: targetTriangle.id,
      userId: { not: null }
    }
  })

  if (filledPositions === 15) {
    await handleTriangleCompletion(targetTriangle.id)
  }

  return availablePosition
}

export async function handleTriangleCompletion(triangleId: string) {
  // Mark triangle as complete
  await prisma.triangle.update({
    where: { id: triangleId },
    data: { 
      isComplete: true,
      completedAt: new Date()
    }
  })

  // Get position A user (the one who will be forced to withdraw)
  const positionA = await prisma.trianglePosition.findFirst({
    where: {
      triangleId: triangleId,
      level: 1,
      position: 0
    },
    include: { user: true, triangle: true }
  })

  if (positionA?.user) {
    // Get plan details for payout amount
    const plan = await prisma.plan.findUnique({
      where: { name: positionA.triangle.planType }
    })

    if (plan) {
      // Create automatic withdrawal transaction
      await prisma.transaction.create({
        data: {
          userId: positionA.user.id,
          type: 'WITHDRAWAL',
          amount: plan.payout,
          status: 'PENDING',
          transactionId: `WD${Date.now()}`,
          description: 'Automatic withdrawal - Triangle completion'
        }
      })

      // Update user balance and total earned
      await prisma.user.update({
        where: { id: positionA.user.id },
        data: {
          balance: { increment: plan.payout },
          totalEarned: { increment: plan.payout }
        }
      })
    }
  }

  // Start triangle cycling process
  await cycleTriangle(triangleId)
}

export async function cycleTriangle(triangleId: string) {
  // Get all positions from the completed triangle
  const positions = await prisma.trianglePosition.findMany({
    where: { triangleId },
    include: { user: true, triangle: true },
    orderBy: [
      { level: 'asc' },
      { position: 'asc' }
    ]
  });

  const triangle = positions[0]?.triangle;
  if (!triangle) return;

  // Get AB1 and AB2 users (they will become new A positions)
  const ab1Position = positions.find(p => p.level === 2 && p.position === 0);
  const ab2Position = positions.find(p => p.level === 2 && p.position === 1);

  const ab1User = ab1Position?.user;
  const ab2User = ab2Position?.user;

  if (ab1User && ab2User) {
    // Create two new triangles
    const triangle1 = await createTriangle(triangle.planType);
    const triangle2 = await createTriangle(triangle.planType);

    // Assign AB1 to position A of triangle1
    await prisma.trianglePosition.update({
      where: {
        triangleId_level_position: {
          triangleId: triangle1.id,
          level: 1,
          position: 0
        }
      },
      data: { userId: ab1User.id }
    });

    // Assign AB2 to position A of triangle2
    await prisma.trianglePosition.update({
      where: {
        triangleId_level_position: {
          triangleId: triangle2.id,
          level: 1,
          position: 0
        }
      },
      data: { userId: ab2User.id }
    });

    // Define the proper subtree mappings for vertical split with promotion
    // AB1's subtree (left side): B1C1 -> AB1, B1C2 -> AB2, C1D1 -> B1C1, etc.
    const ab1SubtreeMap = {
      'B1C1': 'AB1',
      'B1C2': 'AB2',
      'C1D1': 'B1C1',
      'C1D2': 'B1C2',
      'C2D1': 'B2C1',
      'C2D2': 'B2C2'
    };

    // AB2's subtree (right side): B2C1 -> AB1, B2C2 -> AB2, C3D1 -> B1C1, etc.
    const ab2SubtreeMap = {
      'B2C1': 'AB1',
      'B2C2': 'AB2',
      'C3D1': 'B1C1',
      'C3D2': 'B1C2',
      'C4D1': 'B2C1',
      'C4D2': 'B2C2'
    };

    // Move users from AB1's subtree to triangle1 with promotion
    for (const [oldKey, newKey] of Object.entries(ab1SubtreeMap)) {
      const oldPosition = positions.find(p => p.positionKey === oldKey);
      if (oldPosition?.user) {
        // Find the corresponding position in triangle1
        const newPosition = await prisma.trianglePosition.findFirst({
          where: {
            triangleId: triangle1.id,
            positionKey: newKey
          }
        });

        if (newPosition) {
          await prisma.trianglePosition.update({
            where: { id: newPosition.id },
            data: { userId: oldPosition.user.id }
          });
        }
      }
    }

    // Move users from AB2's subtree to triangle2 with promotion
    for (const [oldKey, newKey] of Object.entries(ab2SubtreeMap)) {
      const oldPosition = positions.find(p => p.positionKey === oldKey);
      if (oldPosition?.user) {
        // Find the corresponding position in triangle2
        const newPosition = await prisma.trianglePosition.findFirst({
          where: {
            triangleId: triangle2.id,
            positionKey: newKey
          }
        });

        if (newPosition) {
          await prisma.trianglePosition.update({
            where: { id: newPosition.id },
            data: { userId: oldPosition.user.id }
          });
        }
      }
    }
  }

  // Delete the old triangle and all its positions
  // First delete all positions in the triangle
  await prisma.trianglePosition.deleteMany({
    where: { triangleId: triangleId }
  });

  // Then delete the triangle itself
  await prisma.triangle.delete({
    where: { id: triangleId }
  });
}

export async function getUserTriangleInfo(userId: string) {
  // Get all positions for this user, ordered by creation date (newest first)
  const positions = await prisma.trianglePosition.findMany({
    where: { userId },
    include: {
      triangle: {
        include: {
          positions: {
            include: { user: true },
            orderBy: [
              { level: 'asc' },
              { position: 'asc' }
            ]
          }
        }
      }
    },
    orderBy: { createdAt: 'desc' } // Get newest positions first
  })

  // If no positions found, return null
  if (positions.length === 0) {
    return null
  }

  // Use the most recent position (first in the ordered list)
  const position = positions[0]

  const filledPositions = position.triangle.positions.filter(p => p.userId).length
  const completion = (filledPositions / 15) * 100

  return {
    triangle: position.triangle,
    userPosition: position,
    completion,
    filledPositions
  }
}

export async function findReferrer(referralCode: string) {
  // Helper function to check if a string is a valid MongoDB ObjectId
  function isValidObjectId(id: string): boolean {
    return /^[0-9a-fA-F]{24}$/.test(id)
  }

  let referrer = null

  // Strategy 1: Exact ObjectId match
  if (isValidObjectId(referralCode)) {
    referrer = await prisma.user.findUnique({
      where: { id: referralCode },
      select: { id: true, username: true, plan: true }
    })
  }

  // Strategy 2: Username match
  if (!referrer) {
    referrer = await prisma.user.findUnique({
      where: { username: referralCode },
      select: { id: true, username: true, plan: true }
    })
  }

  // Strategy 3: Referral code match
  if (!referrer) {
    referrer = await prisma.user.findUnique({
      where: { referralCode: referralCode },
      select: { id: true, username: true, plan: true }
    })
  }

  // Strategy 4: Partial ObjectId match (last 8 characters)
  if (!referrer && referralCode.length >= 3) {
    const users = await prisma.user.findMany({
      select: { id: true, username: true, plan: true }
    })
    
    referrer = users.find(user => 
      user.id.toLowerCase().endsWith(referralCode.toLowerCase())
    ) || null
  }

  return referrer
}