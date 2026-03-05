import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jinja2|txt|xml|ico|webp|avif|jpg|jpeg|gif|svg|ttf|woff|woff2|eot|otf|png)).*)",
    "/(api|trpc)(.*)",
  ],
};
