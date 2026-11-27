Unofficial app. Not affiliated with, endorsed by or supported by SATS.

Let your home react to your booked SATS classes. Add each SATS member in the household as a device, then use Flows to:

- Do something a set number of minutes before a booked class starts, for example open the bedroom curtains an hour before a morning class.
- React when a class ends, is cancelled, or gets a new instructor.
- Get notified when you move from the waiting list to booked, or when your waiting-list position changes.
- Check whether a class starts at a given time and weekday, is within a distance from home, or is at one of your home centres.

The device shows your next booked class, your next waiting-list class and your best waiting-list position. A dashboard widget lists the coming week's classes for all members.

How it works: you log in once with your own SATS account while adding the device. The app keeps only a login token on your Homey and discards the password. It reads your bookings about every 30 minutes. It cannot book or cancel classes.

The app uses the same private API as the SATS mobile app. SATS can change that API at any time, and the app then stops working until it is updated. Use it only with your own account, at your own risk.

Source code, documentation and issues: https://github.com/magpern/homey-sats
