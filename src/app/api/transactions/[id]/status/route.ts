import { NextRequest, NextResponse } from 'next/server'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Await the params to fix the Next.js dynamic route issue
    const { id } = await params
    
    // Build where clause to handle both ObjectId and transactionId
    const where: any = {
      OR: [
        { transactionId: id }
      ]
    }
    
    // Only add id match if the id looks like a MongoDB ObjectId
    if (/^[0-9a-fA-F]{24}$/.test(id)) {
      where.OR.push({ id })
    }
    
    // Find transaction by ID or transactionId
    const transaction = await prisma.transaction.findFirst({
      where,
      include: {
        user: true
      }
    })
    
    if (!transaction) {
      return NextResponse.json(
        { error: 'Transaction not found' },
        { status: 404 }
      )
    }
    
    // Prepare response based on transaction status
    let response: any = {
      id: transaction.id,
      type: transaction.type,
      amount: transaction.amount,
      status: transaction.status,
      closable: true,
      deleteAccount: false,
      // Include user data for rejoining flow
      user: transaction.user ? {
        username: transaction.user.username,
        walletAddress: transaction.user.walletAddress
      } : null
    }
    
    switch (transaction.status) {
      case 'PENDING':
        response.message = 'Your transaction is pending admin review. Please wait for confirmation.'
        response.closable = false
        break
      case 'CONFIRMED':
        response.message = 'Your transaction has been confirmed! You now have full access to the platform.'
        break
      case 'COMPLETED':
        // MARK: Updated message for completed withdrawals
        response.message = 'Your withdrawal has been completed! You can now join a new triangle formation.'
        response.showJoinTriangle = true // New flag to show join triangle option
        
        // Include rejoin data for completed withdrawals
        try {
          if (transaction.type === 'WITHDRAWAL' && transaction.metadata) {
            const metadata = transaction.metadata as any;
            if (metadata.rejoinData) {
              response.rejoinData = metadata.rejoinData;
              console.log('Rejoin data included in response:', metadata.rejoinData); // Debug log
            }
          }
        } catch (e) {
          console.error('Error processing rejoin data:', e);
        }
        break
      case 'REJECTED':
        response.message = 'Your transaction has been rejected.'
        response.rejectionReason = 'Payment not received or invalid amount.'
        response.deleteAccount = true
        break
      default:
        response.message = 'Transaction status unknown.'
    }
    
    return NextResponse.json(response)
  } catch (error) {
    console.error('Error fetching transaction status:', error)
    return NextResponse.json(
      { error: 'Failed to fetch transaction status' },
      { status: 500 }
    )
  } finally {
    await prisma.$disconnect()
  }
}