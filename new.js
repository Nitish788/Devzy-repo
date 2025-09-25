mport { clerkClient } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const authSeller = async (userId) => {
    try {

        const client = await clerkClient()
        const user = await client.users.getUser(userId)

        if (user.publicMetadata.role === 'seller') {
            return true;
        } else {
            return false;
        }
    } catch (error) {
        console.log("Error connecting to Clerk Client", error)
        return NextResponse.json({ success: false, message: error.message });
    }
}

export default authSeller;
