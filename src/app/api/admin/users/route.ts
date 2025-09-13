import { NextRequest, NextResponse } from 'next/server'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'

const prisma = new PrismaClient()

// Helper function to verify admin status
async function verifyAdmin(request: NextRequest) {
  try {
    const sessionToken = request.cookies.get('next-auth.session-token')?.value
    
    if (!sessionToken) {
      return null
    }
    
    const decoded = jwt.verify(
      sessionToken,
      process.env.NEXTAUTH_SECRET || 'fallback-secret'
    ) as { user: any }
    
    if (decoded && decoded.user && decoded.user.isAdmin) {
      return decoded.user
    }
    
    return null
  } catch (error) {
    console.error('Session verification error:', error)
    return null
  }
}

export async function GET(request: NextRequest) {
  const adminUser = await verifyAdmin(request)
  if (!adminUser) {
    return NextResponse.json(
      { error: 'Unauthorized - Admin access required' },
      { status: 401 }
    )
  }
  
  try {
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search') || ''
    const plan = searchParams.get('plan') || 'all'
    const status = searchParams.get('status') || 'all'
    const position = searchParams.get('position') || 'all' // Add position filter
    
    // Build where clause - exclude deleted users
    const where: any = {
      // Use a different approach for checking null values in MongoDB
      isAdmin: false // Exclude admin users from the list
    }
    
    // Add search filter
    if (search) {
      where.OR = [
        { username: { contains: search, mode: 'insensitive' } },
        { walletAddress: { contains: search, mode: 'insensitive' } },
        { referralCode: { contains: search, mode: 'insensitive' } }
      ]
    }
    
    // Add plan filter
    if (plan && plan !== 'all') {
      where.plan = plan
    }

    // Add status filter
    if (status && status !== 'all') {
      if (status === 'active') {
        where.status = 'CONFIRMED'
        where.isActive = true
      } else if (status === 'pending') {
        where.status = 'PENDING'
      } else if (status === 'suspended') {
        where.isActive = false
      }
    }
    
    // Fetch users with triangle position info
    const users = await prisma.user.findMany({
      where,
      include: {
        trianglePosition: {
          include: {
            triangle: true
          }
        },
        downlines: true,
        transactions: {
          where: { type: 'REFERRAL_BONUS' }
        }
      },
      orderBy: { createdAt: 'desc' }
    })
    
    // Filter out deleted users manually (workaround for MongoDB null issue)
    let nonDeletedUsers = users.filter(user => !user.deletedAt)
    
    // Apply position filter after fetching
    if (position && position !== 'all') {
      if (position === 'no-position') {
        // Filter users with no position
        nonDeletedUsers = nonDeletedUsers.filter(user => !user.trianglePosition || user.trianglePosition.length === 0);
      } else {
        // Filter users with specific position
        nonDeletedUsers = nonDeletedUsers.filter(user => 
          user.trianglePosition && 
          user.trianglePosition.length > 0 && 
          user.trianglePosition[0].positionKey === position
        );
      }
    }
    
    // Transform data for frontend
    const formattedUsers = nonDeletedUsers.map(user => {
      const referralBonus = user.transactions
        .filter(tx => tx.type === 'REFERRAL_BONUS')
        .reduce((sum, tx) => sum + tx.amount, 0)

      return {
        id: user.id,
        username: user.username,
        walletAddress: user.walletAddress,
        plan: user.plan,
        trianglePosition: user.trianglePosition?.[0]?.positionKey || null,
        triangleId: user.trianglePosition?.[0]?.triangleId || null,
        triangleComplete: user.trianglePosition?.[0]?.triangle?.isComplete || false,
        filledPositions: 0, // Will be calculated if needed
        referralCode: user.referralCode,
        balance: user.balance,
        totalEarned: user.totalEarned,
        planEarnings: user.totalEarned - referralBonus,
        referralBonus: referralBonus,
        referralCount: user.downlines.length,
        createdAt: user.createdAt.toISOString(),
        status: user.status,
        isActive: user.isActive,
        isAdmin: user.isAdmin
      }
    })
    
    return NextResponse.json(formattedUsers)
  } catch (error) {
    console.error('Error fetching users:', error)
    return NextResponse.json(
      { error: 'Failed to fetch users' },
      { status: 500 }
    )
  } finally {
    await prisma.$disconnect()
  }
}